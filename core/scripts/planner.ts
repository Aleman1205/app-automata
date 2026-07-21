// ─────────────────────────────────────────────────────────────────────────────
// La mitad delantera completa del loop, EN VIVO: idea → intake (Sonnet) → spec →
// planner (Opus) → vista + contrato de resultado, con la puerta de coherencia.
// Cuesta centavos (Sonnet + Opus) y necesita ANTHROPIC_API_KEY.
//
//   npm run planner:live                    (idea de Vitrales por defecto)
//   npm run planner:live -- "mi proceso…"
// ─────────────────────────────────────────────────────────────────────────────
import { IntakeAgent } from "../src/intake/agent.ts";
import { intakeSpecABuildSpec } from "../src/intake/adapter.ts";
import { PlannerAgent } from "../src/planner/agent.ts";
import { validarCoherencia, contratoATexto } from "../src/planner/coherencia.ts";

const IDEA_DEFAULT =
  "Cada mes exporto del sistema del restaurante un Excel de popularidad de productos, y a mano saco cuánto vendí, " +
  "la utilidad y qué platillos son los que más dejan. Me toma horas y quiero un tablero que me lo dé solo.";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Falta ANTHROPIC_API_KEY (el intake + planner cuestan centavos).");
    process.exit(1);
  }
  const idea = process.argv.slice(2).join(" ").trim() || IDEA_DEFAULT;
  console.log(`Idea:\n  "${idea}"\n`);

  console.log("[1/2] Intake (Sonnet)…");
  const res = await new IntakeAgent().entrevistar(idea);
  if (res.accion === "rechazar") {
    console.log(`  ✗ Rechazado (${res.viabilidad}).`);
    return;
  }
  const buildSpec = intakeSpecABuildSpec(res.spec);
  console.log(`  ✓ spec: "${buildSpec.objetivo.slice(0, 70)}…" (${buildSpec.criterios_exito.length} criterios)`);

  console.log("\n[2/2] Planner (Opus) → vista + contrato…");
  const plan = await new PlannerAgent().planear(buildSpec);
  const coh = validarCoherencia(plan.vista, plan.resultado_contrato);
  console.log(`  ✓ vista: ${plan.vista.bloques.length} bloques (${plan.vista.bloques.map((b) => b.tipo).join(", ")})`);
  console.log(`  ✓ contrato: ${plan.resultado_contrato.campos.length} campos`);
  console.log(`  Coherencia vista↔contrato: ${coh.ok ? "✓ pasa" : "✗ " + coh.errores.join("; ")}`);

  console.log("\nContrato que el builder debe cumplir:");
  console.log(contratoATexto(plan.resultado_contrato).split("\n").map((l) => "  " + l).join("\n"));

  console.log("\n✓ Front-half del loop: idea → spec → vista + contrato, coherentes.");
  console.log("  Con esto, `construir(deps, { spec, vista: plan.vista, contratoTexto })` + --build");
  console.log("  cierra el loop completo hasta el run→vista (el build cuesta ~$2).");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
