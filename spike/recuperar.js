// Recupera los outputs (y, si se puede, el costo) de una sesión del spike que YA
// corrió, sin volver a ejecutar el build. Útil cuando el agente terminó y el
// Verifier aprobó, pero la descarga de archivos reventó la corrida.
//
//   export ANTHROPIC_API_KEY=sk-ant-...
//   node spike/recuperar.js <session_id> [caso_id]
//
// Ej: node spike/recuperar.js sesn_01UeZzRHFM7TgqwoJ7gTf13K dashboard-popularidad

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

const sessionId = process.argv[2];
const casoId = process.argv[3] || "dashboard-popularidad";
if (!sessionId) {
  console.error("Uso: node spike/recuperar.js <session_id> [caso_id]");
  process.exit(1);
}

// Mismo precio que run.js (Opus 4.8, $/millón de tokens).
const PRECIO = { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const costoDe = (u) =>
  ((u.input_tokens || 0) * PRECIO.in +
    (u.output_tokens || 0) * PRECIO.out +
    (u.cache_read_input_tokens || 0) * PRECIO.cacheRead +
    (u.cache_creation_input_tokens || 0) * PRECIO.cacheWrite) /
  1_000_000;

const client = new Anthropic();

// --- 1. Bajar los archivos de salida (best-effort, por archivo) --------------
const destino = path.join(AQUI, "salidas", casoId);
fs.mkdirSync(destino, { recursive: true });

console.log(`Recuperando de ${sessionId} → spike/salidas/${casoId}/\n`);

let bajados = 0, omitidos = 0;
try {
  const lista = await client.beta.files.list({
    scope_id: sessionId,
    betas: ["managed-agents-2026-04-01"],
  });
  for (const f of lista.data ?? []) {
    try {
      const resp = await client.beta.files.download(f.id);
      const nombre = path.basename(f.filename);
      fs.writeFileSync(path.join(destino, nombre), Buffer.from(await resp.arrayBuffer()));
      console.log(`  ✓ ${nombre}`);
      bajados++;
    } catch (e) {
      console.log(`  · omitido ${path.basename(f.filename || f.id)} (${e.message})`);
      omitidos++;
    }
  }
} catch (e) {
  console.error(`  ⚠ no se pudo listar archivos: ${e.message}`);
}
console.log(`\n${bajados} archivo(s) recuperado(s), ${omitidos} omitido(s).`);

// --- 2. Intentar recobrar el costo re-leyendo los eventos (best-effort) -------
console.log("\nIntentando recobrar el costo desde los eventos de la sesión…");
try {
  let costo = 0, vistos = 0;
  const stream = await client.beta.sessions.events.stream(sessionId);
  for await (const ev of stream) {
    if (ev.type === "span.model_request_end" && ev.model_usage) {
      costo += costoDe(ev.model_usage);
      vistos++;
    }
    if (ev.type === "session.status_terminated") break;
    if (ev.type === "session.status_idle" && ev.stop_reason?.type !== "requires_action") break;
  }
  if (vistos > 0) {
    console.log(`  ✓ Costo recobrado de ${vistos} request(s) de modelo:  $${costo.toFixed(2)}`);
  } else {
    console.log("  · El stream no reprodujo eventos de uso.");
    console.log(`    Ve el costo real en: https://platform.claude.com/workspaces/default/sessions/${sessionId}`);
  }
} catch (e) {
  console.log(`  · No se pudo re-leer el stream (${e.message}).`);
  console.log(`    Ve el costo real en: https://platform.claude.com/workspaces/default/sessions/${sessionId}`);
}
