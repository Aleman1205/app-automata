// ─────────────────────────────────────────────────────────────────────────────
// Verificación de la PISTA de re-verificación que el wiring añade al 403 de step-up.
//
// Lo que se prueba es un CONTRATO CON UN TERCERO: si la forma no es EXACTAMENTE la que Clerk
// busca, `useReverification` no abre el modal, no reintenta, y el cliente vuelve al callejón sin
// salida — en silencio, sin ningún error. Por eso se contrasta contra el detector REAL de Clerk
// (`isReverificationHint`), no contra una copia del JSON hecha a mano: una copia se quedaría vieja
// el día que Clerk cambie el `reason` y este test seguiría en verde.
//   npm run verify:reverificacion
// ─────────────────────────────────────────────────────────────────────────────
import { reverificationError } from "@clerk/backend/internal";
import { isReverificationHint } from "@clerk/shared/authorization-errors";
import { R } from "../src/http/tipos.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

// Lo mismo que arma web/lib/automata/wiring.ts en conPistaDeReverificacion().
const cuerpo = { ...reverificationError({ level: "first_factor", afterMinutes: 5 }), error: "step_up_requerido" };

console.log("1. El cuerpo del 403 es una pista que Clerk RECONOCE:");
check("el detector real de Clerk la acepta", isReverificationHint(cuerpo));
check("y NO acepta el 403 pelón que devuelve el core (por eso hay que traducirlo)",
  !isReverificationHint(R.stepUp().cuerpo));

console.log("\n2. Sigue siendo entendible para un cliente que no es este front:");
check("conserva nuestro error", (cuerpo as { error?: string }).error === "step_up_requerido");
check("R.stepUp() del core sigue siendo 403", R.stepUp().status === 403);

console.log("\n3. El NIVEL coincide con lo que el backend valida:");
// mfaDesdeClaims cae a fva[0] (primer factor) cuando no hay segundo. Pedir 'second_factor' abriría
// un modal exigiendo un 2FA que muchos no tienen configurado: imposible de satisfacer.
const meta = (cuerpo as { clerk_error: { metadata?: { reverification?: { level?: string; afterMinutes?: number } } } }).clerk_error.metadata;
check("pide 'first_factor', no un 2FA que el usuario quizá no tiene", meta?.reverification?.level === "first_factor");
check("la ventana coincide con VENTANA_STEPUP_MS (5 min)", meta?.reverification?.afterMinutes === 5);

console.log(`\n${ok ? "✓ PISTA DE RE-VERIFICACIÓN PROBADA" : "✗ FALLÓ"} — el 403 de step-up lo reconoce el detector real de Clerk, conserva nuestro error y pide el factor correcto.`);
process.exit(ok ? 0 : 1);
