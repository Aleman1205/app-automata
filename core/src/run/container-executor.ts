import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  outMaxFiles: number; // nº máx de archivos en /out
  outMaxBytes: number; // suma máx de bytes en /out
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
  // /out es un mount al disco del HOST: --read-only protege el rootfs del contenedor, no la
  // carpeta del anfitrión. Sin cota, el código de IA llena el disco de la máquina que lo hospeda.
  // Mismos números que LocalPythonExecutor (LIMITES_DEFAULT): dos runners del mismo puerto que
  // acotaran distinto sería una diferencia de comportamiento invisible hasta que duele.
  outMaxFiles: 50,
  outMaxBytes: 100 * 1024 * 1024,
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

      const jaula = (nombre: string) => [
        "run", "--rm", "--name", nombre,
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
        "python3", "/work/automatizacion.py",
      ];

      // ESCALERA de convenciones, igual que LocalPythonExecutor. El agente es estocástico y ya
      // eligió la segunda forma en el PRIMER build real: leyó argv[2] como ruta del resultado y
      // escribió un archivo llamado literalmente "--salida", perdiendo un build de ~$1.8. Pasar
      // las dos en la misma invocación NO es la solución: rompe a cualquier script con argparse,
      // o sea al bien portado, que es justo el que el prompt pide.
      const convenciones: string[][] = [
        [`/work/${nombreInput}`, "--salida", "/out"], // el contrato que fija el prompt (cma/build.ts)
        [`/work/${nombreInput}`, "/out/resultado.json"], // argv[2] = ruta del resultado
      ];

      const inicio = Date.now();
      let code = -1, stderr = "", salidas: string[] = [];
      let nombreResultado: string | undefined;
      for (const [i, argv] of convenciones.entries()) {
        if (i > 0) {
          // Limpiar entre intentos: si no, la basura del fallido se cuenta como salida del bueno.
          await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
          await fs.mkdir(outDir, { recursive: true });
        }
        const nombre = `automata-run-${randomUUID()}`;
        ({ code, stderr } = await this.correr([...jaula(nombre), ...argv], nombre));
        salidas = await fs.readdir(outDir).catch(() => [] as string[]);
        // Cota ANTES de leer nada y por CADA intento: una bomba de salida tiene que reventar en el
        // primero, no acumularse. Se comprueba aquí y no en el contenedor porque el mount escribe
        // en el disco del HOST, donde --read-only no alcanza.
        if (salidas.length > this.cfg.outMaxFiles) {
          throw new Error(`El artefacto produjo demasiados archivos (${salidas.length} > ${this.cfg.outMaxFiles}).`);
        }
        let totalBytes = 0;
        for (const f of salidas) {
          totalBytes += (await fs.stat(path.join(outDir, f))).size;
          if (totalBytes > this.cfg.outMaxBytes) throw new Error(`La salida excede ${this.cfg.outMaxBytes} bytes.`);
        }
        if (code !== 0) continue;
        nombreResultado = NOMBRES_RESULTADO.find((n) => salidas.includes(n));
        if (nombreResultado) break;
      }
      const ms = Date.now() - inicio;
      if (!nombreResultado) {
        if (code !== 0) throw new Error(`El artefacto falló (exit ${code}):\n${stderr.slice(0, 2000)}`);
        throw new Error(`El artefacto no produjo un resultado JSON (${NOMBRES_RESULTADO.join(" / ")}). Produjo: ${salidas.join(", ")}`);
      }
      const resultado = JSON.parse(await leerAcotado(path.join(outDir, nombreResultado), this.cfg.resultMaxBytes));

      // El Run NO usa modelo: el costo es solo session-hours de la infra del runner, que se
      // contabiliza donde se reporta (no aquí). $0 de tokens.
      return { resultado, ms, costoUsd: 0, salidas };
    } finally {
      await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    }
  }

  private correr(args: string[], nombre: string): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const hijo = spawn(this.cfg.binario, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      hijo.stderr.on("data", (d) => { if (stderr.length < 65_536) stderr += d.toString(); });
      // Matar el cliente dispara su 'close', que llegaría a `resolve` ANTES de que el rechazo por
      // timeout se emita (ahora espera a que `docker rm` termine) — y la promesa se quedaría con
      // el resolve: el llamador vería `exit -1` en vez de un timeout, la escalera reintentaría la
      // segunda convención y el Run tardaría el DOBLE antes de dar un error equivocado. Este flag
      // es lo único que ordena la carrera.
      let vencido = false;
      const t = setTimeout(() => {
        vencido = true;
        // Matar el CLIENTE de docker NO mata el contenedor: el proceso que corre dentro sigue
        // vivo en el daemon, quemando CPU y RAM del host indefinidamente. El comentario anterior
        // ("el --rm + el kill del proceso docker detiene el contenedor") era falso, y el test lo
        // demostró: tras un timeout con `while True: pass` quedaba un huérfano corriendo. En un
        // runner multi-tenant esos huérfanos se acumulan hasta tumbar la máquina.
        // Por eso el contenedor lleva --name: es el asa para matarlo de verdad.
        const err = new Error(`Run excedió ${this.cfg.timeoutMs / 1000}s.`);
        try { hijo.kill("SIGKILL"); } catch { /* ya murió */ }
        const matar = spawn(this.cfg.binario, ["rm", "-f", nombre], { stdio: "ignore" });
        // Se rechaza CUANDO el contenedor ya murió, no antes: así el llamador no puede seguir
        // creyendo que la jaula quedó limpia mientras sigue viva. Con red de seguridad por si
        // el propio `rm` se cuelga.
        const red = setTimeout(() => reject(err), 10_000);
        const fin = () => { clearTimeout(red); reject(err); };
        matar.on("close", fin);
        matar.on("error", fin);
      }, this.cfg.timeoutMs);
      hijo.on("error", (e) => { if (vencido) return; clearTimeout(t); reject(e); });
      hijo.on("close", (code) => { if (vencido) return; clearTimeout(t); resolve({ code: code ?? -1, stderr }); });
    });
  }
}
