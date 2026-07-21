import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Artefacto, RunExecutor } from "../types.ts";

// Ejecuta el artefacto sobre los insumos. Es el RUN: código puro, SIN modelo.
// En M0 corre Python local (costo $0). En CMA sería una sesión de sandbox; el
// costo ahí es solo session-hours ($0.08/h, docs/decisiones-runtime.md #3) —
// aún así, sin tokens porque el Run no usa modelo.
//
// Convención M0: el "resultado" es el primer JSON que el script escribe con uno
// de estos nombres. En producción el manifiesto declarará el archivo de salida.
const NOMBRES_RESULTADO = ["resultado.json", "dashboard.json", "salida.json"];

const TIMEOUT_MS = 300_000;

function correrPython(script: string, args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", [script, ...args], { cwd });
    let stderr = "";
    // Cota el buffer: el artefacto es código de IA sin sandbox en M0; un script
    // que escupe a stderr en bucle no debe agotar la memoria del orquestador.
    py.stderr.on("data", (d) => {
      if (stderr.length < 65_536) stderr += d.toString();
    });
    py.stdout.on("data", () => {}); // el script imprime progreso; lo ignoramos
    const t = setTimeout(() => {
      py.kill("SIGKILL");
      reject(new Error(`Run excedió ${TIMEOUT_MS / 1000}s (posible bomba o cuelgue).`));
    }, TIMEOUT_MS);
    py.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    py.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export class LocalPythonExecutor implements RunExecutor {
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
      const { code, stderr } = await correrPython(scriptPath, [primerInput, "--salida", outDir], dir);
      const ms = Date.now() - inicio;
      if (code !== 0) {
        throw new Error(`El artefacto falló (exit ${code}):\n${stderr.slice(0, 2000)}`);
      }

      const salidas = await fs.readdir(outDir);
      const nombreResultado = NOMBRES_RESULTADO.find((n) => salidas.includes(n));
      if (!nombreResultado) {
        throw new Error(`El artefacto no produjo un resultado JSON (${NOMBRES_RESULTADO.join(" / ")}). Produjo: ${salidas.join(", ")}`);
      }
      const resultado = JSON.parse(await fs.readFile(path.join(outDir, nombreResultado), "utf8"));

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
