// ─────────────────────────────────────────────────────────────────────────────
// Verificación de clasificarSesion() SIN credenciales de CMA: es lógica pura que
// decide, del estado de una sesión re-consultada, si el build pasó/falló/sigue. Es la
// ÚNICA fuente de verdad del desenlace (el webhook de CMA es thin). El resto del
// CmaBuildClient toca la red y se prueba con credenciales, aparte.
//   npm run verify:cma
// ─────────────────────────────────────────────────────────────────────────────
import { clasificarSesion, type SesionCma } from "../src/cma/build.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const s = (o: Partial<SesionCma>): SesionCma => ({ id: "sesn_x", ...o });

async function main() {
  console.log("clasificarSesion (desenlace real de una sesión de build):\n");

  // Aprobado
  const okc = clasificarSesion(s({ status: "idle", outcome_evaluations: [{ result: "satisfied", iteration: 1 }] }));
  check("satisfied → satisfecho", okc.estado === "satisfecho");
  check("satisfied cuenta iteraciones (iteration 1 → 2)", okc.iteraciones === 2);

  // El guard clave: satisfied PERO idle-bloqueado esperando acción NO es 'listo'
  check(
    "satisfied + stop_reason=requires_action → en_curso (NO confirmar)",
    clasificarSesion(s({ stop_reason: { type: "requires_action" }, outcome_evaluations: [{ result: "satisfied", iteration: 0 }] })).estado === "en_curso",
  );

  // Terminaciones de grader → fallido
  for (const r of ["max_iterations_reached", "failed", "interrupted"]) {
    check(`grader '${r}' → fallido`, clasificarSesion(s({ outcome_evaluations: [{ result: r, iteration: 3 }] })).estado === "fallido");
  }
  check(
    "fallido lleva motivo con el resultado del grader",
    (clasificarSesion(s({ outcome_evaluations: [{ result: "failed", iteration: 0 }] })).motivo ?? "").includes("failed"),
  );

  // Sesión terminada con error (a nivel sesión, no grader) → fallido aun sin evals
  check("status='terminated' sin evals → fallido", clasificarSesion(s({ status: "terminated" })).estado === "fallido");
  check(
    "status='terminated' gana aunque haya un 'satisfied' viejo",
    clasificarSesion(s({ status: "terminated", outcome_evaluations: [{ result: "satisfied", iteration: 0 }] })).estado === "fallido",
  );

  // No terminal → en_curso (el llamador reintenta; NO confirma ni falla)
  check("sin outcome_evaluations → en_curso", clasificarSesion(s({ status: "idle" })).estado === "en_curso");
  check("resultado no terminal (needs_revision) → en_curso", clasificarSesion(s({ outcome_evaluations: [{ result: "needs_revision", iteration: 0 }] })).estado === "en_curso");

  // Toma la ÚLTIMA evaluación (el grader itera; la última manda)
  check(
    "múltiples evals: la última (satisfied) manda sobre las previas",
    clasificarSesion(s({ outcome_evaluations: [{ result: "needs_revision", iteration: 0 }, { result: "satisfied", iteration: 1 }] })).estado === "satisfecho",
  );

  console.log(`\n${ok ? "✓ clasificarSesion PROBADA" : "✗ FALLÓ"} — el éxito solo se declara con 'satisfied' no-bloqueado; todo lo demás es fallo o reintento.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
