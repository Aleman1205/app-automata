import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Artefacto, RunExecutor } from "../types.ts";

// Ejecuta el artefacto sobre los insumos. Es el RUN: código puro, SIN modelo.
//
// a5-Fase 0 ("puente", auditoría de riesgo): esto NO es una jaula real (red/FS/kernel
// exigen contenedor — Fase 2, gVisor). Es contención de bajo costo para la ventana
// INTERNA/M0 (corre en la máquina del fundador / VM aislada):
//   · env ALLOWLIST → el código de IA no hereda DATABASE_URL/ANTHROPIC/R2 (fuga de secretos).
//   · intérprete por RUTA ABSOLUTA (el env saneado no debe dejar al hijo sin su python).
//   · ulimit -t/-f → cota de CPU y tamaño de archivo por-proceso (NO -u: es per-USER y
//     tumbaría la máquina de dev).
//   · kill del GRUPO al timeout → no deja huérfanos.
//   · lectura ACOTADA del resultado → cierra el OOM por resultado.json gigante.
// La red y el aislamiento cross-tenant siguen ABIERTOS por diseño: son la compuerta que
// BLOQUEA promover esto a usuarios externos (ahí entra el runner de Fase 1/2).
//
// En CMA sería una sesión de sandbox; el costo ahí es solo session-hours ($0.08/h,
// docs/decisiones-runtime.md #3) — aún así, sin tokens porque el Run no usa modelo.
//
// Convención M0: el "resultado" es el primer JSON que el script escribe con uno
// de estos nombres. En producción el manifiesto declarará el archivo de salida.
const NOMBRES_RESULTADO = ["resultado.json", "dashboard.json", "salida.json"];

// Límites por defecto (inyectables por el constructor para tests con valores chicos).
export interface LimitesRun {
  timeoutMs: number; // reloj de pared → SIGKILL al grupo
  cpuMaxS: number; // ulimit -t (segundos de CPU, por-proceso)
  fsizeMaxKb: number; // ulimit -f (tamaño máx por archivo que el proceso escribe)
  outMaxFiles: number; // nº máx de archivos en /out
  outMaxBytes: number; // suma máx de bytes en /out
  resultMaxBytes: number; // cota del resultado.json ANTES de JSON.parse (anti-OOM)
  permitirEnProduccion: boolean; // guard: este executor NO es de producción multi-tenant
}
const LIMITES_DEFAULT: LimitesRun = {
  timeoutMs: 300_000,
  cpuMaxS: 300,
  fsizeMaxKb: 100 * 1024, // 100 MB/archivo (docs/02 §6)
  outMaxFiles: 50,
  outMaxBytes: 100 * 1024 * 1024, // 100 MB total
  resultMaxBytes: 16 * 1024 * 1024, // 16 MB
  permitirEnProduccion: false,
};

// Resolución del intérprete UNA vez, con el PATH HEREDADO (antes de acotar el env), para
// que el env saneado del hijo no lo deje sin el python correcto (anaconda/venv/homebrew).
let PY_ABS: string | undefined;
function pythonAbs(): string {
  if (PY_ABS) return PY_ABS;
  if (process.platform === "win32") { PY_ABS = "python"; return PY_ABS; }
  const salida = execFileSync("/usr/bin/env", ["python3", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  PY_ABS = salida.trim().split("\n")[0] || "/usr/bin/python3";
  return PY_ABS;
}

// env ALLOWLIST: nada de secretos. Se PASAN solo variables seguras de locale/zona; el resto
// (DATABASE_URL, ANTHROPIC_API_KEY, AWS/R2, *_TOKEN, *_KEY…) NO se hereda.
const PASA_SEGURAS = ["LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;
function envLimpio(dir: string): NodeJS.ProcessEnv {
  const pyDir = path.dirname(pythonAbs());
  const env: NodeJS.ProcessEnv = {
    PATH: `${pyDir}:/usr/bin:/bin`,
    // HOME REAL a propósito: python resuelve su user-site (p.ej. ~/Library/Python/.../
    // site-packages, donde vive openpyxl en dev) a partir de $HOME. El aislamiento de
    // FILESYSTEM (que el código de IA no lea $HOME) es de la jaula real (Fase 2), no del
    // puente — igual que la red. Lo que el puente SÍ cierra es la fuga de SECRETOS por env.
    HOME: process.env.HOME ?? dir,
    TMPDIR: dir,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
  };
  for (const k of PASA_SEGURAS) if (process.env[k]) env[k] = process.env[k];
  if (!env["LANG"] && !env["LC_ALL"]) env["LC_ALL"] = "en_US.UTF-8"; // fallback razonable
  return env;
}

function correrPython(script: string, args: string[], cwd: string, lim: LimitesRun): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const py = pythonAbs();
    // Wrapper POSIX: ulimit -t (CPU) y -f (tamaño de archivo) son POR-PROCESO (seguros).
    // NO se usa -u (nº de procesos): es POR-USUARIO y tumbaría la máquina de dev. El
    // aislamiento de red/procesos real es del contenedor (Fase 2). exec reemplaza al shell
    // (mismo PID) → con detached, ese PID es líder de grupo y kill(-pid) mata todo el árbol.
    const guion = 'ulimit -t "$2" 2>/dev/null; ulimit -f "$3" 2>/dev/null; py="$1"; shift 3; exec "$py" "$@"';
    const hijo = process.platform === "win32"
      ? spawn(py, [script, ...args], { cwd, env: envLimpio(cwd) })
      : spawn("/bin/sh", ["-c", guion, "automata-run", py, String(lim.cpuMaxS), String(lim.fsizeMaxKb), script, ...args],
          { cwd, env: envLimpio(cwd), detached: true });

    let stderr = "";
    hijo.stderr.on("data", (d) => { if (stderr.length < 65_536) stderr += d.toString(); });
    hijo.stdout.on("data", () => {}); // el script imprime progreso; lo ignoramos

    const matarGrupo = () => {
      try { if (hijo.pid && process.platform !== "win32") process.kill(-hijo.pid, "SIGKILL"); else hijo.kill("SIGKILL"); }
      catch { try { hijo.kill("SIGKILL"); } catch { /* ya murió */ } }
    };
    const t = setTimeout(() => { matarGrupo(); reject(new Error(`Run excedió ${lim.timeoutMs / 1000}s (posible bomba o cuelgue).`)); }, lim.timeoutMs);
    hijo.on("error", (e) => { clearTimeout(t); reject(e); });
    hijo.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? -1, stderr }); });
  });
}

// Lee HASTA maxBytes+1 sin cargar el archivo entero en RAM: si excede, lanza. Cierra el
// hueco del resultado.json gigante (JSON.parse de un archivo sin cota = OOM del orquestador).
async function leerAcotado(ruta: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(ruta, "r");
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new Error(`El resultado excede la cota de ${maxBytes} bytes (posible bomba de salida).`);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

export class LocalPythonExecutor implements RunExecutor {
  private lim: LimitesRun;
  constructor(opts: Partial<LimitesRun> = {}) {
    this.lim = { ...LIMITES_DEFAULT, ...opts };
    // Guard anti-prod: este executor NO enjaula red/FS/kernel; en producción multi-tenant
    // el runner es CMA o un contenedor (Fase 1/2). En serverless ni siquiera puede spawn.
    if (process.env.NODE_ENV === "production" && !this.lim.permitirEnProduccion) {
      throw new Error("LocalPythonExecutor no es un runner de producción (sin jaula real). Usa el runner de Fase 1/2, o pasa permitirEnProduccion en dev.");
    }
  }

  async run(
    artefacto: Artefacto,
    inputs: Record<string, string>,
  ): Promise<{ resultado: unknown; ms: number; costoUsd: number; salidas: string[] }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automata-run-"));
    try {
      const scriptPath = path.join(dir, "automatizacion.py");
      const outDir = path.join(dir, "out");
      await fs.writeFile(scriptPath, artefacto.automatizacionPy);
      await fs.mkdir(outDir, { recursive: true });

      // El primer insumo de tipo archivo es el argumento posicional del script.
      const primerInput = Object.values(inputs)[0];
      if (!primerInput) throw new Error("El Run necesita al menos un archivo de entrada.");

      const inicio = Date.now();
      const { code, stderr } = await correrPython(scriptPath, [primerInput, "--salida", outDir], dir, this.lim);
      const ms = Date.now() - inicio;
      if (code !== 0) {
        throw new Error(`El artefacto falló (exit ${code}):\n${stderr.slice(0, 2000)}`);
      }

      const salidas = await fs.readdir(outDir);
      // Cota del directorio de salida (nº y bytes) ANTES de leer nada (anti agotamiento).
      if (salidas.length > this.lim.outMaxFiles) {
        throw new Error(`El artefacto produjo demasiados archivos (${salidas.length} > ${this.lim.outMaxFiles}).`);
      }
      let totalBytes = 0;
      for (const f of salidas) {
        totalBytes += (await fs.stat(path.join(outDir, f))).size;
        if (totalBytes > this.lim.outMaxBytes) throw new Error(`La salida excede ${this.lim.outMaxBytes} bytes.`);
      }

      const nombreResultado = NOMBRES_RESULTADO.find((n) => salidas.includes(n));
      if (!nombreResultado) {
        throw new Error(`El artefacto no produjo un resultado JSON (${NOMBRES_RESULTADO.join(" / ")}). Produjo: ${salidas.join(", ")}`);
      }
      const resultado = JSON.parse(await leerAcotado(path.join(outDir, nombreResultado), this.lim.resultMaxBytes));

      // Local = $0. session-hours equivalente en CMA se calcula donde se reporta.
      return { resultado, ms, costoUsd: 0, salidas };
    } finally {
      // El temp dir siempre se limpia (éxito o error): no se fuga en cada Run.
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Costo equivalente si esta corrida hubiera sido en CMA (solo session-hours). */
export function costoCmaEquivalente(ms: number): number {
  return (ms / 3_600_000) * 0.08; // $0.08 por session-hour
}
