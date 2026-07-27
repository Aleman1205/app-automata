import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Artefacto, RunExecutor } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Runner de PRODUCCIÓN (a5-Fase 2): ejecuta el código de IA en un contenedor gVisor —
// la jaula real que cierra el riesgo #1 (escape/red/FS/cross-tenant). Implementa el MISMO
// puerto RunExecutor que LocalPythonExecutor, así que se intercambia sin tocar el pipeline.
//
// Aislamiento (gVisor runsc + flags de docker/nerdctl):
//   --runtime=runsc      kernel de usuario gVisor (no el del host)
//   --network none       SIN red (no exfiltración; el Run no la necesita)
//   --read-only          rootfs de solo lectura; /out es un mount de escritura acotado
//   --user 65534:65534   nobody (sin privilegios)
//   --pids-limit         corta fork-bombs (a nivel cgroup, lo que el puente NO podía)
//   --memory / --cpus    tope DURO de RAM (docs/02 §6: 512MB) y CPU
//   --cap-drop ALL --security-opt no-new-privileges  sin capabilities ni escalada
// El script + el input se montan de solo lectura; el resultado sale por el mount /out.
//
// RUNTIME: requiere un host con Docker/nerdctl + gVisor (runsc) instalado. No corre en
// serverless; el runner vive en su propia infra (Fly/Cloud Run Jobs/VM). El costo del Run
// sigue siendo SIN modelo (docs/decisiones-runtime #3). Aquí se deja cableado; se prueba al
// desplegar el runner (decisión: contenedor gVisor self-hosted).
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfigContenedor {
  imagen: string; // imagen con python + las deps pre-horneadas (openpyxl/pandas/...)
  runtime: string; // "runsc" (gVisor). En dev sin gVisor se puede probar con "runc" (SIN jaula real).
  binario: string; // "docker" | "nerdctl"
  timeoutMs: number;
  memoria: string; // p.ej. "512m"
  cpus: string; // p.ej. "1"
  pidsLimit: number;
  resultMaxBytes: number;
}
const DEFAULT: ConfigContenedor = {
  imagen: "automata/runner:latest",
  runtime: "runsc",
  binario: "docker",
  timeoutMs: 300_000,
  memoria: "512m",
  cpus: "1",
  pidsLimit: 256,
  resultMaxBytes: 16 * 1024 * 1024,
};

const NOMBRES_RESULTADO = ["resultado.json", "dashboard.json", "salida.json"];

// Lee hasta maxBytes+1 sin cargar todo a RAM (mismo guard que el puente): si excede, lanza.
async function leerAcotado(ruta: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(ruta, "r");
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new Error(`El resultado excede la cota de ${maxBytes} bytes.`);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

export class ContainerRunExecutor implements RunExecutor {
  private cfg: ConfigContenedor;
  constructor(opts: Partial<ConfigContenedor> = {}) {
    this.cfg = { ...DEFAULT, ...opts };
  }

  async run(
    artefacto: Artefacto,
    inputs: Record<string, string>,
  ): Promise<{ resultado: unknown; ms: number; costoUsd: number; salidas: string[] }> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "automata-crun-"));
    const workDir = path.join(base, "work"); // solo lectura dentro del contenedor
    const outDir = path.join(base, "out"); // escritura acotada
    try {
      await fs.mkdir(workDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(workDir, "automatizacion.py"), artefacto.automatizacionPy);

      const primer = Object.values(inputs)[0];
      if (!primer) throw new Error("El Run necesita al menos un archivo de entrada.");
      const nombreInput = path.basename(primer);
      await fs.copyFile(primer, path.join(workDir, nombreInput));

      const args = [
        "run", "--rm",
        "--runtime", this.cfg.runtime,
        "--network", "none",
        "--read-only",
        "--user", "65534:65534",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", String(this.cfg.pidsLimit),
        "--memory", this.cfg.memoria,
        "--cpus", this.cfg.cpus,
        "-v", `${workDir}:/work:ro`,
        "-v", `${outDir}:/out`,
        this.cfg.imagen,
        "python3", "/work/automatizacion.py", `/work/${nombreInput}`, "--salida", "/out",
      ];

      const inicio = Date.now();
      const { code, stderr } = await this.correr(args);
      const ms = Date.now() - inicio;
      if (code !== 0) throw new Error(`El artefacto falló (exit ${code}):\n${stderr.slice(0, 2000)}`);

      const salidas = await fs.readdir(outDir);
      const nombreResultado = NOMBRES_RESULTADO.find((n) => salidas.includes(n));
      if (!nombreResultado) throw new Error(`El artefacto no produjo un resultado JSON (${NOMBRES_RESULTADO.join(" / ")}). Produjo: ${salidas.join(", ")}`);
      const resultado = JSON.parse(await leerAcotado(path.join(outDir, nombreResultado), this.cfg.resultMaxBytes));

      // El Run NO usa modelo: el costo es solo session-hours de la infra del runner, que se
      // contabiliza donde se reporta (no aquí). $0 de tokens.
      return { resultado, ms, costoUsd: 0, salidas };
    } finally {
      await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    }
  }

  private correr(args: string[]): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const hijo = spawn(this.cfg.binario, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      hijo.stderr.on("data", (d) => { if (stderr.length < 65_536) stderr += d.toString(); });
      // El --rm + el kill del proceso docker detiene el contenedor; el timeout es el reloj de pared.
      const t = setTimeout(() => { try { hijo.kill("SIGKILL"); } catch { /* ya murió */ } reject(new Error(`Run excedió ${this.cfg.timeoutMs / 1000}s.`)); }, this.cfg.timeoutMs);
      hijo.on("error", (e) => { clearTimeout(t); reject(e); });
      hijo.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? -1, stderr }); });
    });
  }
}
