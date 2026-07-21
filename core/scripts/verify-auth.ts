// ─────────────────────────────────────────────────────────────────────────────
// Verificación GRATIS de la capa de ROL (M2, docs/13 §2 + docs/11 §10). Sin DB:
// prueba assertCan con membresías fixture (elevación intra-org y cross-org).
// El AISLAMIENTO por org_id (RLS) se prueba aparte contra Postgres (db/*.sql).
//
//   npm run verify:auth
// ─────────────────────────────────────────────────────────────────────────────
import { assertCan, necesitaStepUp, NoAutorizado, type Membresia } from "../src/auth/roles.ts";

let ok = true;
const check = (nombre: string, paso: boolean) => {
  console.log(`  ${paso ? "✓" : "✗"} ${nombre}`);
  ok = ok && paso;
};
const deniega = (fn: () => void) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof NoAutorizado;
  }
};
const permite = (fn: () => void) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

const admin: Membresia = { orgId: "A", userId: "u_ana", rol: "admin" };
const operador: Membresia = { orgId: "A", userId: "u_luis", rol: "operador" };

console.log("1. Matriz de rol (docs/13 §2):");
check("admin puede crear_build", permite(() => assertCan(admin, "A", "crear_build")));
check("operador NO puede crear_build", deniega(() => assertCan(operador, "A", "crear_build")));
check("operador NO puede facturación", deniega(() => assertCan(operador, "A", "facturacion")));
check("operador SÍ puede ejecutar", permite(() => assertCan(operador, "A", "ejecutar")));
check("operador SÍ puede descargar", permite(() => assertCan(operador, "A", "descargar")));
check("admin puede borrar_org", permite(() => assertCan(admin, "A", "borrar_org")));

console.log("\n2. Aislamiento a nivel de rol (cross-org / ex-miembro) — docs/11 §10:");
check("admin de A NO puede actuar sobre org B (cross-org)", deniega(() => assertCan(admin, "B", "ejecutar")));
check("sin membresía (ex-miembro) → denegado", deniega(() => assertCan(undefined, "A", "ejecutar")));

console.log("\n3. Step-up MFA para acciones peligrosas (docs/13 §1):");
check("facturación exige step-up", necesitaStepUp("facturacion"));
check("borrar_org exige step-up", necesitaStepUp("borrar_org"));
check("quitar_gente exige step-up", necesitaStepUp("quitar_gente"));
check("ejecutar NO exige step-up", !necesitaStepUp("ejecutar"));

console.log(`\n${ok ? "✓ M2 (capa de ROL) PROBADA" : "✗ FALLÓ"} — assertCan correcto. (El aislamiento por org es RLS: db/test-aislamiento.sql.)`);
process.exit(ok ? 0 : 1);
