// Preflight del spike — comprobación GRATIS antes de gastar créditos.
//
// Verifica dos cosas sin correr ningún build (sin tokens de modelo):
//   1. Que ANTHROPIC_API_KEY esté puesta y sea válida.
//   2. Que tu cuenta tenga acceso a Managed Agents (beta) — el bloqueo más
//      probable que queda.
//
//   export ANTHROPIC_API_KEY=sk-ant-...
//   node spike/preflight.js

import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("✕ Falta ANTHROPIC_API_KEY. Corre:  export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const client = new Anthropic();

try {
  // Listar entornos NO consume tokens de modelo: es la prueba más barata de que
  // la key sirve y el beta está activo.
  let n = 0;
  for await (const _e of client.beta.environments.list()) {
    n++;
    if (n >= 3) break;
  }
  console.log("✓ API key válida.");
  console.log(`✓ Managed Agents (beta) accesible (${n} entorno(s) existentes).`);
  console.log("\n  Todo listo. Ahora el build real (~$3-5):  npm run spike");
} catch (err) {
  const msg = err?.message ?? String(err);
  console.error(`✕ Error (${err?.status ?? "?"}): ${msg}`);
  if (/beta|access|managed|agent|not.*(enabled|allowed)|403|404/i.test(msg)) {
    console.error("\n  → Parece que Managed Agents (beta) NO está activado en tu cuenta.");
    console.error("    Actívalo en console.anthropic.com o escribe a support.anthropic.com.");
    console.error("    (Tener créditos de API no es lo mismo que tener el beta habilitado.)");
  } else if (/auth|api.?key|401|invalid/i.test(msg)) {
    console.error("\n  → La key no es válida o está mal copiada. Revísala.");
  }
  process.exit(1);
}
