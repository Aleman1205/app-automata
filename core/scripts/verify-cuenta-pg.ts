// ─────────────────────────────────────────────────────────────────────────────
// Verificación de la API de LECTURA de EQUIPO + CUENTA (GET) contra Postgres. Corre los
// HANDLERS bajo conOrg (rol de app, RLS): confirma que (1) listar equipo ve SOLO los
// miembros de la org con su rol + la marca `esTu`, (2) cuenta une plan+límites+consumo del
// periodo, contando espacios ACTIVOS y usuarios vivos y el flujo del mes (uso_periodo), y
// (3) el aislamiento: otra org ve su propio equipo/plan, no el ajeno. El periodo se computa
// con el MISMO to_char(now(),'YYYY-MM') que cobra la cuota → panel y cobro no divergen.
//   ADMIN_URL=... DATABASE_URL=... npm run verify:cuenta:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { listarEquipoEP, verCuentaEP } from "../src/http/endpoints.ts";
import type { PoolClient } from "pg";
import type { Contexto, Respuesta } from "../src/http/tipos.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // plan equipo
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // plan base (aislamiento)

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
// Invoca un handler con un Contexto mínimo. La org efectiva la fija conOrg (RLS); aquí solo
// importan `identidad` (para `esTu`) y el `input`.
const invocar = <T>(ep: { handler: (c: Contexto<T>) => Promise<Respuesta> }, c: PoolClient, input: T, userId: string, org: string): Promise<Respuesta> =>
  ep.handler({ cliente: c, input, orgId: org, identidad: { userId }, membresia: { orgId: org, userId, rol: "admin" } });

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]);
    // A: plan equipo, 3 miembros (1 admin + 2 operadores), 2 automatizaciones activas + 1 inactiva.
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'A'),($2,'B')", [A, B]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [A]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'base')", [B]);
    await admin.query("INSERT INTO memberships (org_id,user_id,rol) VALUES ($1,'u_ana','admin'),($1,'u_luis','operador'),($1,'u_carmen','operador')", [A]);
    await admin.query("INSERT INTO memberships (org_id,user_id,rol) VALUES ($1,'u_otro','admin')", [B]);
    await admin.query("INSERT INTO automatizaciones (org_id,nombre,activa) VALUES ($1,'a1',true),($1,'a2',true),($1,'a3',false)", [A]);
    await admin.query("INSERT INTO automatizaciones (org_id,nombre,activa) VALUES ($1,'b1',true)", [B]);
    // Consumo del MES actual de A (mismo to_char(now(),'YYYY-MM') que usa el endpoint).
    await admin.query("INSERT INTO uso_periodo (org_id,periodo,generaciones,ejecuciones) VALUES ($1, to_char(now(),'YYYY-MM'), 5, 42)", [A]);

    console.log("1. equipo: ve SOLO los miembros de la org, con rol + marca 'esTu':");
    const eq = await conOrg(app, A, (c) => invocar(listarEquipoEP, c, {}, "u_ana", A));
    const ms = (eq.cuerpo as { miembros: Array<{ userId: string; rol: string; esTu: boolean }>; total: number }).miembros;
    const byU = Object.fromEntries(ms.map((m) => [m.userId, m]));
    check("devuelve exactamente los 3 de A (ninguno de B)", ms.length === 3 && !byU["u_otro"]);
    check("total coincide con la lista", (eq.cuerpo as { total: number }).total === 3);
    check("rol correcto (u_ana admin, u_luis operador)", byU["u_ana"]?.rol === "admin" && byU["u_luis"]?.rol === "operador");
    check("orden: admin primero", ms[0]?.rol === "admin");
    check("esTu marca SOLO al que pide (u_ana)", byU["u_ana"]?.esTu === true && byU["u_luis"]?.esTu === false && byU["u_carmen"]?.esTu === false);

    console.log("\n2. cuenta: plan + límites del plan + consumo (stock vivo + flujo del mes):");
    const cta = await conOrg(app, A, (c) => invocar(verCuentaEP, c, {}, "u_ana", A));
    const d = cta.cuerpo as {
      plan: { clave: string; estado: string };
      limites: { espacios: number; usuarios: number; generaciones: number; ejecuciones: number; exportarCodigo: boolean; reparaciones: number };
      uso: { periodo: string; espacios: number; usuarios: number; generaciones: number; ejecuciones: number };
    };
    check("status 200", cta.status === 200);
    check("plan = equipo, estado = activa", d.plan.clave === "equipo" && d.plan.estado === "activa");
    check("límites del plan equipo (espacios 10, usuarios 10, gen 20, ejec 10000, exportar sí)",
      d.limites.espacios === 10 && d.limites.usuarios === 10 && d.limites.generaciones === 20 && d.limites.ejecuciones === 10000 && d.limites.exportarCodigo === true);
    check("uso.espacios cuenta SOLO las activas (2 de 3)", d.uso.espacios === 2);
    check("uso.usuarios cuenta los miembros vivos (3)", d.uso.usuarios === 3);
    check("uso del mes = uso_periodo (gen 5, ejec 42)", d.uso.generaciones === 5 && d.uso.ejecuciones === 42);
    check("periodo con formato YYYY-MM", /^[0-9]{4}-[0-9]{2}$/.test(d.uso.periodo));

    console.log("\n3. aislamiento: otra org (B) ve SU equipo y SU plan, no el de A:");
    const eqB = await conOrg(app, B, (c) => invocar(listarEquipoEP, c, {}, "u_otro", B));
    check("equipo de B = 1 miembro (u_otro)", (eqB.cuerpo as { miembros: unknown[] }).miembros.length === 1);
    const ctaB = await conOrg(app, B, (c) => invocar(verCuentaEP, c, {}, "u_otro", B));
    const dB = ctaB.cuerpo as { plan: { clave: string }; limites: { espacios: number }; uso: { espacios: number; usuarios: number; generaciones: number } };
    check("plan de B = base (espacios 3)", dB.plan.clave === "base" && dB.limites.espacios === 3);
    check("uso de B: 1 activa, 1 usuario, 0 generaciones (sin uso_periodo)", dB.uso.espacios === 1 && dB.uso.usuarios === 1 && dB.uso.generaciones === 0);
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ API DE EQUIPO + CUENTA PROBADA" : "✗ FALLÓ"} — equipo/cuenta bajo RLS: ve solo su org, deriva límites+consumo, y el cross-org está aislado.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
