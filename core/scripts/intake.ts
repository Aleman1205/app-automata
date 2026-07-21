// ─────────────────────────────────────────────────────────────────────────────
// Intake EN VIVO: corre la entrevista real (Sonnet) sobre una idea en lenguaje
// natural y produce un spec validado, listo para el build de M0.
// Cuesta centavos (Sonnet) y necesita ANTHROPIC_API_KEY.
//
//   npm run intake:live                      (usa la idea de Vitrales por defecto)
//   npm run intake:live -- "mi proceso…"     (tu propia idea)
// ─────────────────────────────────────────────────────────────────────────────
import { IntakeAgent } from "../src/intake/agent.ts";
import { intakeSpecABuildSpec } from "../src/intake/adapter.ts";
import { validarSpec } from "../src/intake/validator.ts";

const IDEA_DEFAULT =
  "Cada mes exporto del sistema del restaurante un Excel de popularidad de productos, y a mano saco cuánto vendí, " +
  "la utilidad y qué platillos son los que más dejan. Me toma horas y quiero un tablero que me lo dé solo.";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Falta ANTHROPIC_API_KEY. Exporta tu key (el intake cuesta centavos).");
    process.exit(1);
  }
  const idea = process.argv.slice(2).join(" ").trim() || IDEA_DEFAULT;
  console.log(`Idea del cliente:\n  "${idea}"\n`);
  console.log("Entrevistando (Sonnet, respondiendo con la opción recomendada)…\n");

  const agente = new IntakeAgent();
  const res = await agente.entrevistar(idea);

  if (res.accion === "rechazar") {
    console.log(`✗ Rechazado (${res.viabilidad}). Motivo interno: ${res.motivo_interno}`);
    console.log("  (Al cliente se le mostraría un rechazo amable y genérico.)");
    return;
  }

  // res.accion === "cerrar"
  console.log(`✓ Cerró con un spec (viabilidad: ${res.viabilidad}, confianza: ${res.spec.confianza}).`);
  console.log(`  Saludo de aprobación: "${res.saludo}"\n`);
  console.log("Objetivo:\n  " + res.spec.objetivo + "\n");
  console.log("Criterios (lado cliente, lo que aprueba):");
  for (const c of res.spec.criterios_exito) console.log("  · " + c.criterio_cliente);
  if (res.spec.ambiguedades_restantes.length) {
    console.log("\nAmbigüedades a confirmar en la aprobación:");
    for (const a of res.spec.ambiguedades_restantes) console.log("  · " + a);
  }

  const v = validarSpec(res.spec);
  console.log(`\nValidación §4: ${v.ok ? "✓ pasa" : "✗ " + v.errores.join("; ")}`);

  const buildSpec = intakeSpecABuildSpec(res.spec);
  console.log("\nSpec adaptado al formato que consume el Builder de M0:");
  console.log("  objetivo:", buildSpec.objetivo.slice(0, 80) + "…");
  console.log("  reglas:", buildSpec.reglas.length, "· criterios:", buildSpec.criterios_exito.length, "· entradas:", buildSpec.entradas.length);
  console.log("\n✓ M1: idea en lenguaje natural → spec validado y adaptado al formato del Builder.");
  console.log("  NOTA (honesta): conectar este spec al build todavía necesita la VISTA, que produce");
  console.log("  el planner (pendiente). Hoy `npm run m0` usa un caso a mano y NO consume este spec.");
  console.log("  M1 entrega el spec; el cableado intake→planner→build es lo que sigue.");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
