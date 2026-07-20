// SPIKE — prueba técnica desechable.
//
// Pregunta que contesta:
//   ¿Puede un agente tomar la descripción de un proceso real, escribir código
//   que funcione, verificarse solo contra un rubric, y entregar el resultado?
//   ¿En cuánto tiempo y por cuánto dinero?
//
// Esto NO es código de producción. Es una pregunta contestada. Cuando tengas
// los números, se tira.
//
//   npm install
//   npm run datos          # genera los datos de prueba (incluye el .xlsx de Vitrales)
//   export ANTHROPIC_API_KEY=sk-ant-...
//   npm run spike          # todos los casos activos de spike/casos.js
//   npm run spike -- dashboard-popularidad    # uno solo, por id

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { casos } from "./casos.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MODELO = "claude-opus-4-8";
const MAX_ITERACIONES = 4;   // cuántas veces puede reintentar el Verifier
const TIMEOUT_MIN = 15;

// Precio por millón de tokens (Opus 4.8)
const PRECIO = { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 };

const client = new Anthropic();

// ---------------------------------------------------------------- utilidades

const t0 = Date.now();
const log = (msg) => {
  const s = String(Math.floor((Date.now() - t0) / 1000)).padStart(4);
  console.log(`[${s}s] ${msg}`);
};

const costoDe = (u) =>
  ((u.input_tokens || 0) * PRECIO.in +
    (u.output_tokens || 0) * PRECIO.out +
    (u.cache_read_input_tokens || 0) * PRECIO.cacheRead +
    (u.cache_creation_input_tokens || 0) * PRECIO.cacheWrite) /
  1_000_000;

// El rubric es el spec traducido a criterios que un grader independiente puede
// verificar. Esta función es, en miniatura, el trabajo del PLANNER.
const rubricDesde = (spec) => `
# Criterios de aceptación

La automatización está TERMINADA solo si TODOS estos criterios se cumplen,
verificados ejecutando el código sobre el archivo de entrada real:

${spec.criterios_exito.map((c, i) => `${i + 1}. ${c}`).join("\n")}

# Reglas de negocio que el código debe respetar

${spec.reglas.map((r) => `- ${r}`).join("\n")}

# Cómo verificar

No basta con leer el código. Ejecútalo sobre el archivo de entrada, abre el
archivo de salida y comprueba cada criterio con datos reales. Si un criterio
habla de sumas o conteos, calcúlalos de forma independiente y compáralos.
`.trim();

const instruccionesDesde = (spec, rutaEntrada) => `
${spec.objetivo}

El archivo de entrada está en: ${rutaEntrada}

Entregables, ambos obligatorios:
1. Un script reutilizable en /mnt/session/outputs/automatizacion.py que reciba
   la ruta del archivo de entrada como argumento y produzca la salida. Debe
   funcionar con cualquier archivo del mismo formato, no solo con este.
2. El resultado de ejecutarlo sobre el archivo de entrada, también en
   /mnt/session/outputs/.

Además, escribe /mnt/session/outputs/manifiesto.json describiendo qué entradas
necesita el script para correr, con esta forma:
{"entradas": [{"nombre": "...", "tipo": "archivo|texto|numero", "formato": "csv",
  "descripcion": "lo que el usuario debe subir", "requerido": true}]}

Reglas de negocio a respetar:
${spec.reglas.map((r) => `- ${r}`).join("\n")}
`.trim();

// ------------------------------------------------------------ infraestructura

async function prepararInfra() {
  const NOMBRE_ENV = "spike-app-auto";

  let env;
  for await (const e of client.beta.environments.list()) {
    if (e.name === NOMBRE_ENV) { env = e; break; }
  }
  if (!env) {
    env = await client.beta.environments.create({
      name: NOMBRE_ENV,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    log(`Environment creado: ${env.id}`);
  } else {
    log(`Environment reutilizado: ${env.id}`);
  }

  // En producción el agente se crea UNA vez y se guarda el id. Aquí lo creamos
  // cada corrida porque el prompt del sistema es justo lo que estamos afinando.
  const agent = await client.beta.agents.create({
    name: "Builder (spike)",
    model: MODELO,
    system: `
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
funciona con cualquier archivo del mismo formato.

Los datos reales vienen sucios. Espera celdas vacías, tipos mezclados,
espacios sobrantes, mayúsculas inconsistentes y filas duplicadas. Manéjalo.

No pidas confirmación ni hagas preguntas: trabajas de forma autónoma y nadie
está mirando. Si algo es ambiguo, elige la interpretación más razonable,
continúa, y anótala al final.
`.trim(),
    tools: [{ type: "agent_toolset_20260401" }],
  });
  log(`Agente creado: ${agent.id}`);

  return { env, agent };
}

// ------------------------------------------------------------------- un caso

async function correrCaso(caso, { env, agent }) {
  const inicio = Date.now();
  console.log(`\n${"=".repeat(70)}\n  ${caso.nombre}\n${"=".repeat(70)}`);

  const rutaLocal = path.join(AQUI, "datos", caso.archivo);
  if (!fs.existsSync(rutaLocal)) {
    return { caso, ok: false, error: `Falta ${rutaLocal} — corre: npm run datos` };
  }

  const subido = await client.beta.files.upload({
    file: fs.createReadStream(rutaLocal),
    purpose: "agent",
  });
  const rutaRemota = `/workspace/${caso.archivo}`;

  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: env.id,
    title: caso.nombre,
    resources: [{ type: "file", file_id: subido.id, mount_path: rutaRemota }],
  });
  log(`Sesión: ${session.id}`);
  log(`Ver en vivo: https://platform.claude.com/workspaces/default/sessions/${session.id}`);

  // Stream PRIMERO, luego el evento. Al revés se pierden los primeros eventos.
  const stream = await client.beta.sessions.events.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [{
      type: "user.define_outcome",
      description: instruccionesDesde(caso.spec, rutaRemota),
      rubric: { type: "text", content: rubricDesde(caso.spec) },
      max_iterations: MAX_ITERACIONES,
    }],
  });

  let costo = 0, iteraciones = 0, aprobado = false, motivo = "sin resultado";
  const limite = setTimeout(() => stream.controller?.abort(), TIMEOUT_MIN * 60_000);

  try {
    for await (const ev of stream) {
      switch (ev.type) {
        case "agent.tool_use":
          log(`  · ${ev.name}`);
          break;

        case "span.model_request_end":
          if (ev.model_usage) costo += costoDe(ev.model_usage);
          break;

        case "span.outcome_evaluation_end":
          iteraciones = (ev.iteration ?? 0) + 1;
          log(`  ⟳ verificación #${iteraciones}: ${ev.result}`);
          if (ev.explanation) log(`    ${ev.explanation.slice(0, 200)}`);
          aprobado = ev.result === "satisfied";
          motivo = ev.result;
          break;

        case "session.error":
          log(`  ✕ error: ${ev.error?.message ?? "desconocido"}`);
          motivo = "session.error";
          break;
      }

      if (ev.type === "session.status_terminated") { motivo = "terminada"; break; }
      // Ojo: idle NO significa terminado. Solo con stop_reason terminal.
      if (ev.type === "session.status_idle" && ev.stop_reason?.type !== "requires_action") break;
    }
  } finally {
    clearTimeout(limite);
  }

  // Los outputs tardan 1-3s en indexarse tras el idle.
  await new Promise((r) => setTimeout(r, 3000));

  const destino = path.join(AQUI, "salidas", caso.id);
  const archivos = [];
  const omitidos = [];
  // La descarga de outputs es BEST-EFFORT: si falla, NO debe tirar la corrida ni
  // borrar el veredicto/costo que ya se capturaron. Algunos archivos de la sesión
  // (p. ej. la entrada montada) no son descargables y devuelven 400.
  try {
    fs.mkdirSync(destino, { recursive: true });
    const lista = await client.beta.files.list({
      scope_id: session.id,
      betas: ["managed-agents-2026-04-01"],
    });
    for (const f of lista.data ?? []) {
      try {
        const resp = await client.beta.files.download(f.id);
        const nombre = path.basename(f.filename);
        fs.writeFileSync(path.join(destino, nombre), Buffer.from(await resp.arrayBuffer()));
        archivos.push(nombre);
      } catch {
        omitidos.push(path.basename(f.filename || f.id));
      }
    }
  } catch (e) {
    log(`  ⚠ no se pudieron bajar los outputs (${e.message}) — el veredicto sigue válido`);
  }

  const minutos = (Date.now() - inicio) / 60_000;
  log(`${aprobado ? "✓ APROBADO" : `✗ ${motivo}`} · ${minutos.toFixed(1)} min · $${costo.toFixed(2)}`);
  log(`Archivos en spike/salidas/${caso.id}/: ${archivos.join(", ") || "ninguno"}`);
  if (omitidos.length) log(`  (omitidos por no-descargables: ${omitidos.join(", ")})`);

  return { caso, ok: aprobado, motivo, minutos, costo, iteraciones, archivos };
}

// -------------------------------------------------------------------- main

const filtro = process.argv[2];
const aCorrer = filtro ? casos.filter((c) => c.id === filtro) : casos;

if (!aCorrer.length) {
  console.error(`No existe el caso "${filtro}". Disponibles: ${casos.map((c) => c.id).join(", ")}`);
  process.exit(1);
}

const infra = await prepararInfra();
const resultados = [];
for (const caso of aCorrer) {
  try {
    resultados.push(await correrCaso(caso, infra));
  } catch (err) {
    console.error(`\n✗ ${caso.nombre} reventó:`, err.message);
    resultados.push({ caso, ok: false, motivo: err.message, minutos: 0, costo: 0 });
  }
}

// ------------------------------------------------------------------ veredicto

const ok = resultados.filter((r) => r.ok).length;
const costoTotal = resultados.reduce((s, r) => s + (r.costo || 0), 0);
const minProm = resultados.reduce((s, r) => s + (r.minutos || 0), 0) / resultados.length;

console.log(`\n${"=".repeat(70)}\n  RESULTADO DEL SPIKE\n${"=".repeat(70)}`);
for (const r of resultados) {
  const marca = r.ok ? "✓" : "✗";
  const detalle = r.ok
    ? `${r.minutos.toFixed(1)} min · $${r.costo.toFixed(2)} · ${r.iteraciones} iteración(es)`
    : r.motivo;
  console.log(`  ${marca} ${r.caso.nombre.padEnd(45)} ${detalle}`);
}
console.log(`\n  Éxito:            ${ok}/${resultados.length}`);
console.log(`  Costo por build:  $${(costoTotal / resultados.length).toFixed(2)} promedio`);
console.log(`  Tiempo por build: ${minProm.toFixed(1)} min promedio`);

console.log(`
  Cómo leerlo (${resultados.length} caso${resultados.length === 1 ? "" : "s"}):
    todo ✓ y < $5/build   →  el modelo de negocio cierra. Arranca la Fase 1.
    alguna falla suelta    →  revisa qué falló: ¿el rubric era vago, o el agente
                             se equivocó? Casi siempre es el rubric.
    la mayoría ✗, o >$10   →  para. Acota el producto a un tipo de proceso más
                             estrecho, o replantea antes de construir el MVP.

  Con pocos casos el "$/build" es apenas una señal — para sostener el pricing
  conviene correr varios (activa más en spike/casos.js).

  Abre spike/salidas/*/ y revisa los archivos con tus propios ojos. Que el
  Verifier diga "aprobado" no es lo mismo que esté bien.
`);
