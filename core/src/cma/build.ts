import { createReadStream } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { BuildClient, CodigoConstruido, Manifiesto, Spec } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Builder en Managed Agents (CMA). Lifteado del spike/run.js YA PROBADO
// (3/3, ~$1.8/build), adaptado al puerto BuildClient y a la decisión (b):
//   · deps de la lista blanca PRE-HORNEADAS en el environment (`packages`)
//   · `networking: limited` con allowed_hosts vacío → el build NO tiene red
// (docs/decisiones-runtime.md #2). Así se cierra la exfiltración-en-build sin
// runner propio.
//
// OJO: este módulo gasta dinero y tarda ~10 min. No se corre en la verificación
// gratis de M0; el loop se prueba con el artefacto ya construido del spike.
// ─────────────────────────────────────────────────────────────────────────────

const MODELO = "claude-opus-4-8";
const MAX_ITERACIONES = 4;
const TIMEOUT_MIN = 15;
const PRECIO = { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 } as const;

// Lista blanca de paquetes (pre-horneados; el build no necesita pip en runtime).
const PAQUETES_PIP = ["openpyxl", "pandas", "python-dateutil"];

const SYSTEM = `
Eres un ingeniero que construye automatizaciones para clientes que no programan.

Trabajas así:
1. Inspecciona el archivo de entrada antes de escribir nada. Nunca supongas
   columnas, formatos ni codificaciones: ábrelo y míralo.
2. Escribe el código.
3. EJECÚTALO sobre el archivo real.
4. Abre la salida y verifica tú mismo cada criterio de aceptación con datos
   reales, calculando sumas y conteos de forma independiente.
5. Solo entonces das el trabajo por terminado.

El código debe ser reutilizable: recibe la ruta de entrada como argumento y
funciona con cualquier archivo del mismo formato. Escribe también
/mnt/session/outputs/manifiesto.json con la forma:
{"entradas":[{"nombre":"...","tipo":"archivo|texto|numero","formato":"csv",
  "descripcion":"...","requerido":true}]}

Los datos reales vienen sucios. Manéjalo. Trabaja de forma autónoma, sin
preguntar; si algo es ambiguo, elige lo más razonable y anótalo al final.
`.trim();

const costoDe = (u: any): number =>
  ((u?.input_tokens || 0) * PRECIO.in +
    (u?.output_tokens || 0) * PRECIO.out +
    (u?.cache_read_input_tokens || 0) * PRECIO.cacheRead +
    (u?.cache_creation_input_tokens || 0) * PRECIO.cacheWrite) /
  1_000_000;

function rubricDesde(spec: Spec): string {
  return [
    "# Criterios de aceptación\n",
    "La automatización está TERMINADA solo si TODOS estos criterios se cumplen,",
    "verificados ejecutando el código sobre el archivo de entrada real:\n",
    spec.criterios_exito.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    "\n# Reglas de negocio que el código debe respetar\n",
    spec.reglas.map((r) => `- ${r}`).join("\n"),
  ].join("\n");
}

function instruccionesDesde(spec: Spec, rutaRemota: string): string {
  return [
    spec.objetivo,
    `\nEl archivo de entrada está en: ${rutaRemota}`,
    "\nEntregables en /mnt/session/outputs/: un script reutilizable",
    "automatizacion.py (recibe la ruta como argumento), su resultado ejecutado, y",
    "manifiesto.json. Reglas de negocio a respetar:",
    spec.reglas.map((r) => `- ${r}`).join("\n"),
  ].join("\n");
}

export class CmaBuildClient implements BuildClient {
  private client = new Anthropic();
  private log = (m: string) => console.log(`  [cma] ${m}`);

  async build(spec: Spec, ejemploPath: string) {
    const NOMBRE_ENV = "automata-core";

    // 1. Environment con la config de la decisión (b): deps pre-horneadas + sin red.
    let env: any;
    for await (const e of this.client.beta.environments.list()) {
      if ((e as any).name === NOMBRE_ENV) {
        env = e;
        break;
      }
    }
    if (!env) {
      env = await this.client.beta.environments.create({
        name: NOMBRE_ENV,
        config: {
          type: "cloud",
          packages: { pip: PAQUETES_PIP },
          // Decisión (b): deps pre-horneadas + SIN red. `allowed_hosts: []` y
          // `allow_package_managers: false` son toggles independientes; ambos
          // hacen falta para cerrar el egress (docs/decisiones-runtime.md #2).
          networking: { type: "limited", allowed_hosts: [], allow_package_managers: false },
        },
      } as any);
      this.log(`environment creado: ${env.id}`);
    } else {
      this.log(`environment reutilizado: ${env.id}`);
    }

    const agent = await this.client.beta.agents.create({
      name: "Builder (core)",
      model: MODELO,
      system: SYSTEM,
      tools: [{ type: "agent_toolset_20260401" } as any],
    } as any);

    // 2. Subir el ejemplo y arrancar la sesión.
    const subido = await this.client.beta.files.upload({
      file: createReadStream(ejemploPath),
      purpose: "agent",
    } as any);
    const rutaRemota = `/workspace/${path.basename(ejemploPath)}`;
    const session = await this.client.beta.sessions.create({
      agent: agent.id,
      environment_id: env.id,
      resources: [{ type: "file", file_id: (subido as any).id, mount_path: rutaRemota }],
    } as any);
    this.log(`sesión: ${session.id}`);

    const stream = await this.client.beta.sessions.events.stream(session.id);
    await this.client.beta.sessions.events.send(session.id, {
      events: [
        {
          type: "user.define_outcome",
          description: instruccionesDesde(spec, rutaRemota),
          rubric: { type: "text", content: rubricDesde(spec) },
          max_iterations: MAX_ITERACIONES,
        },
      ],
    } as any);

    // 3. Escuchar hasta idle terminal; acumular costo e iteraciones.
    let costoUsd = 0;
    let iteraciones = 0;
    let aprobado = false;
    const limite = setTimeout(() => (stream as any).controller?.abort(), TIMEOUT_MIN * 60_000);
    try {
      for await (const ev of stream as any) {
        if (ev.type === "span.model_request_end" && ev.model_usage) costoUsd += costoDe(ev.model_usage);
        if (ev.type === "span.outcome_evaluation_end") {
          iteraciones = (ev.iteration ?? 0) + 1;
          aprobado = ev.result === "satisfied";
          this.log(`verificación #${iteraciones}: ${ev.result}`);
        }
        if (ev.type === "session.status_terminated") break;
        if (ev.type === "session.status_idle" && ev.stop_reason?.type !== "requires_action") break;
      }
    } finally {
      clearTimeout(limite);
    }

    // 4. Extraer el código construido de las salidas.
    await new Promise((r) => setTimeout(r, 3000)); // los outputs tardan en indexarse
    const lista = await this.client.beta.files.list({
      scope_id: session.id,
      betas: ["managed-agents-2026-04-01"],
    } as any);
    const archivos = new Map<string, string>();
    for (const f of (lista as any).data ?? []) {
      const nombre = path.basename((f as any).filename);
      if (nombre === "automatizacion.py" || nombre === "manifiesto.json" || nombre === "requirements.txt") {
        try {
          const resp = await this.client.beta.files.download((f as any).id);
          archivos.set(nombre, Buffer.from(await (resp as any).arrayBuffer()).toString("utf8"));
        } catch {
          /* algunos archivos no son descargables; se omiten */
        }
      }
    }

    const automatizacionPy = archivos.get("automatizacion.py");
    if (!automatizacionPy) throw new Error("El build no produjo automatizacion.py.");
    let manifiesto: Manifiesto = { entradas: [] };
    const manifiestoRaw = archivos.get("manifiesto.json");
    if (manifiestoRaw) {
      try {
        manifiesto = JSON.parse(manifiestoRaw) as Manifiesto;
      } catch {
        /* manifiesto malformado: se deja vacío, la puerta de calidad lo marca */
      }
    }

    const codigo: CodigoConstruido = {
      automatizacionPy,
      manifiesto,
      requirements: archivos.get("requirements.txt"),
    };
    return { codigo, costoUsd, iteraciones, aprobado };
  }
}
