import { createReadStream } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { gatearEjemplo } from "../entrada/puente.ts";
import type {
  ArranqueBuild,
  BuildClientAsync,
  CodigoConstruido,
  Manifiesto,
  PeticionAjuste,
  ResultadoCosecha,
  Spec,
} from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Builder en Managed Agents (CMA). Lifteado del spike/run.js YA PROBADO
// (3/3, ~$1.8/build), adaptado al puerto BuildClient y a la decisión (b):
//   · deps de la lista blanca PRE-HORNEADAS en el environment (`packages`)
//   · `networking: limited` con allowed_hosts vacío → el build NO tiene red
// (docs/decisiones-runtime.md #2). Así se cierra la exfiltración-en-build sin
// runner propio.
//
// DOS caminos:
//   · build()  — SÍNCRONO. Abre el stream, espera ~10 min, cosecha. Para M0 y
//                pruebas locales (run-m0). Gasta dinero y tarda; NO va en la ruta HTTP.
//   · arrancar() + cosechar() — ASÍNCRONO, para PRODUCCIÓN. arrancar() crea la
//     sesión y devuelve su id (se graba en versiones.cma_session_id) sin esperar.
//     Cuando CMA notifica por webhook (thin: solo el id de sesión), la orquestación
//     llama cosechar(sessionId), que RE-CONSULTA la sesión para saber el desenlace
//     real y descarga el código.
//
// El webhook de CMA es THIN y se registra en la CONSOLA (no hay API para darlo de
// alta por código). Sus data.type reales — `session.status_idled`,
// `session.status_terminated`, `session.outcome_evaluation_ended` — NO dicen si el
// build pasó: eso solo se sabe re-consultando la sesión (outcome_evaluations[].result
// === "satisfied"). Por eso la decisión de éxito vive en cosechar(), no en el handler.
// ─────────────────────────────────────────────────────────────────────────────

const MODELO = "claude-opus-4-8";
const MAX_ITERACIONES = 4;
const TIMEOUT_MIN = 15;
const PRECIO = { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 } as const;
const NOMBRE_ENV = "automata-core";

// Lista blanca de paquetes (pre-horneados; el build no necesita pip en runtime).
const PAQUETES_PIP = ["openpyxl", "pandas", "python-dateutil"];

// Resultados TERMINALES del grader (docs/managed-agents-outcomes.md). `satisfied` es
// el único aprobado; el resto son terminaciones sin código.
const OUTCOME_OK = "satisfied";
const OUTCOME_FALLO = new Set(["max_iterations_reached", "failed", "interrupted"]);

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

function rubricDesde(spec: Spec, contratoTexto?: string): string {
  return [
    "# Criterios de aceptación\n",
    "La automatización está TERMINADA solo si TODOS estos criterios se cumplen,",
    "verificados ejecutando el código sobre el archivo de entrada real:\n",
    spec.criterios_exito.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    "\n# Reglas de negocio que el código debe respetar\n",
    spec.reglas.map((r) => `- ${r}`).join("\n"),
    // La forma del resultado.json es criterio de aceptación: si no cumple el
    // contrato, la vista no resuelve. El Verifier debe comprobarla.
    contratoTexto ? `\n# Forma OBLIGATORIA del resultado.json (verifícala abriendo el archivo)\n\n${contratoTexto}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function instruccionesDesde(spec: Spec, rutaRemota: string, contratoTexto?: string, ajuste?: PeticionAjuste): string {
  return [
    spec.objetivo,
    `\nEl archivo de entrada está en: ${rutaRemota}`,
    "\nEntregables en /mnt/session/outputs/: un script reutilizable",
    "automatizacion.py (recibe la ruta como argumento), su resultado ejecutado, y",
    "manifiesto.json. Reglas de negocio a respetar:",
    spec.reglas.map((r) => `- ${r}`).join("\n"),
    // El planner fija la forma del resultado.json para que la vista resuelva.
    contratoTexto ? `\n${contratoTexto}` : "",
    // AJUSTE: la automatización ya existe y el cliente pidió un cambio puntual. Se parte del
    // código vigente para no perder el comportamiento que ya aprobó — reinventarlo desde el spec
    // le cambiaría cosas que no pidió.
    ajuste ? seccionAjuste(ajuste) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function seccionAjuste(a: PeticionAjuste): string {
  return [
    `\n─── REVISIÓN (versión ${a.numeroVersion}) ───`,
    "Esta automatización YA EXISTE y el cliente la está usando. NO la reescribas desde cero:",
    "parte del código de abajo y haz SOLO el cambio que pide, conservando todo lo demás",
    "(mismas columnas, mismos nombres, mismo formato de salida) para no romperle lo que ya aprobó.",
    `\nLo que pide el cliente, en sus palabras:\n${a.peticion}`,
    a.codigoAnterior
      ? `\nCódigo de la versión vigente:\n\`\`\`python\n${a.codigoAnterior}\n\`\`\``
      : "\n(No se pudo recuperar el código anterior: reconstrúyelo desde el objetivo y las reglas, y respeta el contrato de salida.)",
  ].join("\n");
}

// Forma (mínima, defensiva) de la sesión re-consultada. El SDK beta la tipa flojo;
// solo leemos lo que necesitamos para clasificar el desenlace.
export interface SesionCma {
  id: string;
  status?: string;
  stop_reason?: { type?: string } | null;
  outcome_evaluations?: Array<{ result?: string; iteration?: number }>;
}

export interface Clasificacion {
  estado: "satisfecho" | "fallido" | "en_curso";
  iteraciones: number;
  motivo?: string;
}

/** Del estado de una sesión re-consultada, decide si el build pasó, falló o sigue.
 *  El webhook es thin: esta es la ÚNICA fuente de verdad del desenlace. Exportada
 *  para probarla sin credenciales (es lógica pura). */
export function clasificarSesion(s: SesionCma): Clasificacion {
  const evals = s.outcome_evaluations ?? [];
  const ult = evals[evals.length - 1];
  const iteraciones = evals.length ? (ult?.iteration ?? 0) + 1 : 0;

  // Terminación con error de la sesión (no del grader) → fallo, haya o no evals.
  if (s.status === "terminated") return { estado: "fallido", iteraciones, motivo: "sesión terminada con error" };
  if (!ult?.result) return { estado: "en_curso", iteraciones }; // aún sin veredicto

  if (ult.result === OUTCOME_OK) {
    // Guard: idle bloqueado esperando una acción (tool/confirmación) NO es "listo".
    if (s.stop_reason?.type === "requires_action") return { estado: "en_curso", iteraciones };
    return { estado: "satisfecho", iteraciones };
  }
  if (OUTCOME_FALLO.has(ult.result)) return { estado: "fallido", iteraciones, motivo: `grader: ${ult.result}` };
  return { estado: "en_curso", iteraciones }; // needs_revision / en progreso
}

export class CmaBuildClient implements BuildClientAsync {
  private client = new Anthropic();
  private log = (m: string) => console.log(`  [cma] ${m}`);

  // ── Setup compartido: environment blindado + agente + subir ejemplo + crear
  //    sesión. NO envía el outcome ni abre stream (cada camino lo hace a su modo). ──
  private async prepararSesion(ejemploPath: string): Promise<{ sessionId: string; rutaRemota: string }> {
    // 1. Environment con la config de la decisión (b): deps pre-horneadas + sin red.
    let env: any;
    for await (const e of this.client.beta.environments.list()) {
      if ((e as any).name === NOMBRE_ENV) { env = e; break; }
    }
    if (!env) {
      env = await this.client.beta.environments.create({
        name: NOMBRE_ENV,
        config: {
          type: "cloud",
          packages: { pip: PAQUETES_PIP },
          // ⚠️ CAMBIO OBLIGADO POR EL API (lo descubrió el primer build real, 2026-07-30).
          // La decisión (b) de docs/decisiones-runtime.md #2 era "deps pre-horneadas + CERO red":
          // allowed_hosts: [] Y allow_package_managers: false. CMA ahora rechaza esa combinación:
          //   400 "Packages cannot be specified with limited networking when
          //        allow_package_managers is disabled."
          // Tiene sentido: las deps hay que BAJARLAS de algún lado. Las dos salidas eran quitar
          // `packages` (y quedarnos sin pandas/openpyxl, que es de lo que viven estas
          // automatizaciones) o permitir los gestores de paquetes. Se elige lo segundo.
          //
          // QUÉ SE PIERDE, dicho claro: el egress ya no es CERO. `allowed_hosts: []` sigue
          // bloqueando hosts arbitrarios, así que el canal se reduce a los repositorios de
          // paquetes (PyPI) — mucho más angosto que red abierta, pero un canal de exfiltración al
          // fin. El riesgo residual del threat model (docs/11) crece y hay que anotarlo ahí.
          networking: { type: "limited", allowed_hosts: [], allow_package_managers: true },
        },
      } as any);
      this.log(`environment creado: ${env.id}`);
    } else {
      this.log(`environment reutilizado: ${env.id}`);
    }

    // NOTA (deploy): el SDK recomienda crear el agente UNA vez y referenciarlo por id
    // (no en la ruta caliente). Aquí se crea por build por simplicidad; en producción
    // conviene provisionar agente+environment fuera de banda (CLI `ant`) y guardar el id.
    const agent = await this.client.beta.agents.create({
      name: "Builder (core)",
      model: MODELO,
      system: SYSTEM,
      tools: [{ type: "agent_toolset_20260401" } as any],
    } as any);

    // Defensa en profundidad (a4): el gate de entrada valida el ejemplo ANTES de subir sus
    // bytes a CMA. prepararSesion es el embudo ÚNICO de build() y arrancar(), así que esto
    // cubre también el camino async aunque su orquestador se cablee después (a3).
    await gatearEjemplo(ejemploPath);
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
    return { sessionId: session.id, rutaRemota };
  }

  private eventoOutcome(spec: Spec, rutaRemota: string, contratoTexto?: string, ajuste?: PeticionAjuste) {
    return {
      events: [
        {
          type: "user.define_outcome",
          description: instruccionesDesde(spec, rutaRemota, contratoTexto, ajuste),
          rubric: { type: "text", content: rubricDesde(spec, contratoTexto) },
          max_iterations: MAX_ITERACIONES,
        },
      ],
    } as any;
  }

  // ── Descarga los entregables de /mnt/session/outputs/ (indexado tras idle). ──
  private async descargarCodigo(sessionId: string): Promise<CodigoConstruido> {
    await new Promise((r) => setTimeout(r, 3000)); // los outputs tardan en indexarse
    const lista = await this.client.beta.files.list({
      scope_id: sessionId,
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
    return { automatizacionPy, manifiesto, requirements: archivos.get("requirements.txt") };
  }

  // ── Camino SÍNCRONO (M0): arranca, escucha hasta idle terminal, cosecha. ──
  async build(spec: Spec, ejemploPath: string, contratoTexto?: string) {
    const { sessionId, rutaRemota } = await this.prepararSesion(ejemploPath);

    // Abrir el stream ANTES de enviar el outcome, para no perder eventos tempranos.
    const stream = await this.client.beta.sessions.events.stream(sessionId);
    await this.client.beta.sessions.events.send(sessionId, this.eventoOutcome(spec, rutaRemota, contratoTexto));

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

    const codigo = await this.descargarCodigo(sessionId);
    return { codigo, costoUsd, iteraciones, aprobado };
  }

  // ── Camino ASÍNCRONO (producción): arranca y NO espera. ──
  async arrancar(spec: Spec, ejemploPath: string, contratoTexto?: string, ajuste?: PeticionAjuste): Promise<ArranqueBuild> {
    const { sessionId, rutaRemota } = await this.prepararSesion(ejemploPath);
    await this.client.beta.sessions.events.send(sessionId, this.eventoOutcome(spec, rutaRemota, contratoTexto, ajuste));
    this.log(`build arrancado (asíncrono): ${sessionId}`);
    return { sessionId };
  }

  // ── Cosecha: el webhook (thin) avisó; re-consultamos para el desenlace real. ──
  async cosechar(sessionId: string): Promise<ResultadoCosecha> {
    const s = (await this.client.beta.sessions.retrieve(sessionId)) as unknown as SesionCma;
    const c = clasificarSesion(s);
    if (c.estado === "en_curso") return { estado: "en_curso" };
    if (c.estado === "fallido") return { estado: "fallido", motivo: c.motivo ?? "desconocido", iteraciones: c.iteraciones };
    // satisfecho: descargar el código. El costo real del build asíncrono NO se
    // reconstruye aquí (no hubo stream); la fuente autoritativa es la consola / la
    // API de uso — mismo caveat que el spike (run.js subcuenta ~1.4×).
    const codigo = await this.descargarCodigo(sessionId);
    return { estado: "satisfecho", codigo, costoUsd: await this.reconstruirCosto(sessionId), iteraciones: c.iteraciones };
  }

  // Reconstruye el costo del build asíncrono re-listando los eventos de la sesión y sumando
  // el de cada model_request (mismo cálculo que el stream síncrono). BEST-EFFORT: si el SDK
  // no expone events.list o falla, devuelve 0 + log — el costo es OBSERVABILIDAD, NUNCA gatea
  // la entrega; la consola es la fuente autoritativa (run.js subcuenta ~1.4×).
  private async reconstruirCosto(sessionId: string): Promise<number> {
    try {
      const resp = (await this.client.beta.sessions.events.list(sessionId)) as any;
      const eventos: any[] = Array.isArray(resp) ? resp : resp?.data ?? [];
      let total = 0;
      for (const ev of eventos) {
        if (ev?.type === "span.model_request_end" && ev.model_usage) total += costoDe(ev.model_usage);
      }
      return total;
    } catch (e) {
      this.log(`no se pudo reconstruir el costo de ${sessionId} (observabilidad, no gatea): ${(e as { message?: string })?.message ?? e}`);
      return 0;
    }
  }
}
