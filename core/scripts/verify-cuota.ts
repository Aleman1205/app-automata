// ─────────────────────────────────────────────────────────────────────────────
// Verificación GRATIS del contrato de planes (M3, docs/06 §8). Sin DB: valores de
// cada plan, la regla 2× (generaciones = 2× espacios), fail-closed en plan inválido,
// y el helper de periodo. El ENFORCEMENT (reserva atómica, corte) se prueba aparte
// contra Postgres en verify-cuota-pg.ts.
//
//   npm run verify:cuota
// ─────────────────────────────────────────────────────────────────────────────
import { PLANES, entitlementsDe, esPlan, type Plan } from "../src/billing/planes.ts";
import { periodoActual } from "../src/billing/cuota.ts";

let ok = true;
const check = (nombre: string, paso: boolean) => {
  console.log(`  ${paso ? "✓" : "✗"} ${nombre}`);
  ok = ok && paso;
};

console.log("1. Valores de docs/06 §8:");
check("base = 3 espacios / 6 gen / 500 ejec / 1 usuario / sin exportar",
  PLANES.base.espaciosActivos === 3 && PLANES.base.generacionesMes === 6 &&
  PLANES.base.ejecucionesMes === 500 && PLANES.base.usuarios === 1 && PLANES.base.exportarCodigo === false);
check("pro = 6 / 12 / 2000 / 3 / sin exportar",
  PLANES.pro.espaciosActivos === 6 && PLANES.pro.generacionesMes === 12 &&
  PLANES.pro.ejecucionesMes === 2000 && PLANES.pro.usuarios === 3 && PLANES.pro.exportarCodigo === false);
check("equipo = 10 / 20 / 10000 / 10 / CON exportar",
  PLANES.equipo.espaciosActivos === 10 && PLANES.equipo.generacionesMes === 20 &&
  PLANES.equipo.ejecucionesMes === 10000 && PLANES.equipo.usuarios === 10 && PLANES.equipo.exportarCodigo === true);

console.log("\n2. La regla anti-desangre (generaciones = 2× espacios, docs/06 §4):");
for (const p of ["base", "pro", "equipo"] as Plan[]) {
  check(`${p}: generaciones = 2× espacios`, PLANES[p].generacionesMes === 2 * PLANES[p].espaciosActivos);
}

console.log("\n3. entitlementsDe fail-closed (plan inválido/ausente LANZA, no asume permisivo):");
const lanza = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
check("plan 'gratis' inexistente → lanza", lanza(() => entitlementsDe("gratis")));
check("plan undefined (sin subscription) → lanza", lanza(() => entitlementsDe(undefined)));
check("plan null → lanza", lanza(() => entitlementsDe(null)));
check("plan válido 'equipo' → NO lanza", !lanza(() => entitlementsDe("equipo")));
check("esPlan discrimina bien", esPlan("base") && !esPlan("enterprise") && !esPlan(""));

console.log("\n4. periodoActual (YYYY-MM en UTC, determinista):");
check("2026-07-21 12:00Z → '2026-07'", periodoActual(new Date("2026-07-21T12:00:00Z")) === "2026-07");
check("2026-01-01 00:00Z → '2026-01' (mes con cero a la izquierda)", periodoActual(new Date("2026-01-01T00:00:00Z")) === "2026-01");
check("2025-12-31 23:59Z → '2025-12'", periodoActual(new Date("2025-12-31T23:59:59Z")) === "2025-12");

console.log(`\n${ok ? "✓ M3 (contrato de planes) PROBADO" : "✗ FALLÓ"} — límites correctos y fail-closed.`);
process.exit(ok ? 0 : 1);
