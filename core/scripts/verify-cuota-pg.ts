// ─────────────────────────────────────────────────────────────────────────────
// Verificación del ENFORCEMENT de cuotas contra Postgres real (M3). El tope lo
// impone la BD (triggers + app_consumir + tabla planes), no el código de la app,
// así que aquí probamos que NI SIQUIERA el rol de app puede saltárselo: no puede
// sobrevender por concurrencia (TOCTOU), ni auto-ascenderse de plan, ni resetear
// sus contadores, y un moroso/cancelado no consume.
//
//   ADMIN_URL=postgres://postgres@host/db  DATABASE_URL=postgres://automata_app@host/db  npm run verify:cuota:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import {
  crearAutomatizacion, invitarMiembro, consumirGeneracion, consumirEjecucion, puedeExportar, CuotaExcedida,
} from "../src/billing/cuota.ts";
import { PLANES, type Plan } from "../src/billing/planes.ts";
import { type Pool, type PoolClient } from "pg";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // base
const E = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"; // equipo
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // equipo + cancelada
const D = "dddddddd-dddd-dddd-dddd-dddddddddddd"; // SIN subscription
const PER = "2026-07";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const esCuota = async (fn: () => Promise<unknown>) => {
  try { await fn(); return false; } catch (e) { return e instanceof CuotaExcedida; }
};
const lanzaNoCuota = async (fn: () => Promise<unknown>) => { // fail-closed / permiso: error duro, NO CuotaExcedida
  try { await fn(); return false; } catch (e) { return !(e instanceof CuotaExcedida); }
};

async function abrirTx(pool: Pool, org: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE automata_app");
  await c.query("SELECT set_config('app.current_org', $1, true)", [org]);
  return c;
}
const cerrar = async (c: PoolClient, cmd: "COMMIT" | "ROLLBACK") => { await c.query(cmd).catch(() => {}); c.release(); };
const activas = (c: PoolClient) =>
  c.query<{ n: number }>("SELECT count(*)::int AS n FROM automatizaciones WHERE activa").then((r) => r.rows[0]?.n ?? 0);

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const seedSub = async (id: string, plan: string, estado = "activa") => {
    await admin.query("INSERT INTO orgs (id, nombre) VALUES ($1, $2)", [id, `M3 ${id.slice(0, 4)}`]);
    await admin.query("INSERT INTO subscriptions (org_id, plan, estado) VALUES ($1, $2, $3)", [id, plan, estado]);
  };
  const resetAutos = (id: string) => admin.query("DELETE FROM automatizaciones WHERE org_id = $1", [id]);
  const seedAutos = (id: string, activa: boolean, n: number) =>
    admin.query(
      "INSERT INTO automatizaciones (org_id, nombre, activa) SELECT $1, 'seed', $2 FROM generate_series(1,$3)",
      [id, activa, n]);
  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, E, C, D]]);
    await seedSub(A, "base");
    await seedSub(E, "equipo");
    await seedSub(C, "equipo", "cancelada");
    await admin.query("INSERT INTO orgs (id, nombre) VALUES ($1, 'sin sub')", [D]); // D sin subscription

    console.log("1. Los límites de la BD == PLANES (TS) (anti-deriva):");
    const db = await admin.query<{ plan: string; espacios: number; generaciones: number; ejecuciones: number; usuarios: number; exportar_codigo: boolean; reparaciones: number }>(
      "SELECT plan, espacios, generaciones, ejecuciones, usuarios, exportar_codigo, reparaciones FROM planes");
    let driftOk = db.rows.length === 3;
    for (const row of db.rows) {
      const t = PLANES[row.plan as Plan];
      driftOk &&= !!t && t.espaciosActivos === row.espacios && t.generacionesMes === row.generaciones &&
        t.ejecucionesMes === row.ejecuciones && t.usuarios === row.usuarios && t.exportarCodigo === row.exportar_codigo &&
        t.reparacionesMes === row.reparaciones;
    }
    check("tabla planes coincide con PLANES en los 3 planes", driftOk);

    console.log("\n2. Tope de espacios (STOCK) — base = 3:");
    for (let i = 1; i <= 3; i++) await conOrg(app, A, (c) => crearAutomatizacion(c, `auto ${i}`));
    check("crea 3 dentro del límite", (await conOrg(app, A, activas)) === 3);
    check("la 4ª lanza CuotaExcedida('espacios')", await esCuota(() => conOrg(app, A, (c) => crearAutomatizacion(c, "4"))));

    console.log("\n3. activa=false NO cuenta contra el stock:");
    await resetAutos(A);
    await seedAutos(A, false, 5); // 5 archivadas (no cuentan)
    for (let i = 1; i <= 3; i++) await conOrg(app, A, (c) => crearAutomatizacion(c, `activa ${i}`));
    check("con 5 inactivas, aún crea 3 activas", (await conOrg(app, A, activas)) === 3);
    check("la 4ª activa lanza CuotaExcedida (inactivas no ocupan)", await esCuota(() =>
      conOrg(app, A, (c) => crearAutomatizacion(c, "x"))));

    console.log("\n4. Concurrencia (TOCTOU) — 2 activas, 1 hueco, dos crean a la vez:");
    await resetAutos(A);
    await seedAutos(A, true, 2);
    const s1 = await abrirTx(app, A);
    await crearAutomatizacion(s1, "ganadora"); // trigger toma advisory lock; cuenta 2<3; inserta (sin commit)
    const s2 = await abrirTx(app, A);
    const p2 = crearAutomatizacion(s2, "perdedora").then(() => "ok").catch((e) => e); // BLOQUEA en el advisory lock
    await cerrar(s1, "COMMIT"); // libera el lock → p2 sigue, ve 3 >= 3
    const r2 = await p2;
    await cerrar(s2, "ROLLBACK");
    check("la 2ª creación concurrente es rechazada (CuotaExcedida)", r2 instanceof CuotaExcedida);
    check("el conteo final es 3, NO sobrevende a 4", (await conOrg(app, A, activas)) === 3);

    console.log("\n5. Otro plan usa OTRO límite — equipo (10), crea 4 (imposible en base):");
    for (let i = 1; i <= 4; i++) await conOrg(app, E, (c) => crearAutomatizacion(c, `eq ${i}`));
    check("equipo permite 4 activas (límite 10, no 3)", (await conOrg(app, E, activas)) >= 4);

    console.log("\n6. Flujo por mes: generaciones (base = 6):");
    for (let i = 1; i <= 6; i++) await conOrg(app, A, (c) => consumirGeneracion(c, PER));
    check("la 7ª generación lanza CuotaExcedida", await esCuota(() => conOrg(app, A, (c) => consumirGeneracion(c, PER))));
    check("el contador es POR MES: 2026-08 vuelve a 1", (await conOrg(app, A, (c) => consumirGeneracion(c, "2026-08"))) === 1);

    console.log("\n7. Tope DURO de ejecuciones, concurrente en el borde (docs/11 §8):");
    await admin.query(
      "INSERT INTO uso_periodo (org_id, periodo, ejecuciones) VALUES ($1,$2,499) ON CONFLICT (org_id,periodo) DO UPDATE SET ejecuciones=499", [A, PER]);
    const e1 = await abrirTx(app, A);
    const v1 = await consumirEjecucion(e1, PER); // → 500, bloquea la fila
    const e2 = await abrirTx(app, A);
    const pe2 = consumirEjecucion(e2, PER).then((v) => v).catch((e) => e); // bloquea hasta commit de e1
    await cerrar(e1, "COMMIT");
    const v2 = await pe2;
    await cerrar(e2, "ROLLBACK");
    check("la ejecución 500 pasa", v1 === 500);
    check("la 501 concurrente es cortada (CuotaExcedida)", v2 instanceof CuotaExcedida);

    console.log("\n8. Tope de usuarios (base = 1):");
    check("invita al 1er miembro (0→1)", await (async () => {
      try { await conOrg(app, A, (c) => invitarMiembro(c, "u_ana", "admin")); return true; } catch { return false; }
    })());
    check("el 2º miembro lanza CuotaExcedida('usuarios')", await esCuota(() =>
      conOrg(app, A, (c) => invitarMiembro(c, "u_luis", "operador"))));

    console.log("\n9. SEGURIDAD — el rol de app NO puede saltarse la cuota:");
    check("NO puede auto-ascender su plan (UPDATE subscriptions → permiso denegado)", await lanzaNoCuota(() =>
      conOrg(app, A, (c) => c.query("UPDATE subscriptions SET plan = 'equipo'"))));
    const planTrasAtaque = await admin.query<{ plan: string }>("SELECT plan FROM subscriptions WHERE org_id=$1", [A]);
    check("el plan sigue siendo 'base' tras el intento", planTrasAtaque.rows[0]?.plan === "base");
    check("NO puede resetear su contador (UPDATE uso_periodo → denegado)", await lanzaNoCuota(() =>
      conOrg(app, A, (c) => c.query("UPDATE uso_periodo SET ejecuciones = 0"))));
    check("NO puede borrar su contador (DELETE uso_periodo → denegado)", await lanzaNoCuota(() =>
      conOrg(app, A, (c) => c.query("DELETE FROM uso_periodo"))));

    console.log("\n10. Subscription cancelada/morosa NO consume (docs/06):");
    check("cancelada: crearAutomatizacion falla (error duro, no CuotaExcedida)", await lanzaNoCuota(() =>
      conOrg(app, C, (c) => crearAutomatizacion(c, "x"))));
    check("cancelada: consumirEjecucion falla", await lanzaNoCuota(() => conOrg(app, C, (c) => consumirEjecucion(c, PER))));
    check("cancelada: puedeExportar = false aunque el plan sea equipo", (await conOrg(app, C, (c) => puedeExportar(c))) === false);

    console.log("\n11. Aislamiento cross-org de las tablas de billing:");
    check("conOrg(A) ve exactamente 1 subscription (la suya)", (await conOrg(app, A, (c) =>
      c.query<{ n: number }>("SELECT count(*)::int AS n FROM subscriptions").then((r) => r.rows[0]?.n))) === 1);
    const usoEantes = await admin.query<{ n: number }>("SELECT coalesce(sum(ejecuciones),0)::int AS n FROM uso_periodo WHERE org_id=$1", [E]);
    await conOrg(app, A, (c) => consumirEjecucion(c, PER)).catch(() => {}); // A consume (o corta); no debe tocar a E
    const usoEdespues = await admin.query<{ n: number }>("SELECT coalesce(sum(ejecuciones),0)::int AS n FROM uso_periodo WHERE org_id=$1", [E]);
    check("consumir en A NO altera el contador de E", usoEantes.rows[0]?.n === usoEdespues.rows[0]?.n);

    console.log("\n12. Fail-closed — org SIN subscription (D):");
    check("crearAutomatizacion en D falla (error duro)", await lanzaNoCuota(() => conOrg(app, D, (c) => crearAutomatizacion(c, "x"))));
    check("consumirEjecucion en D falla (error duro)", await lanzaNoCuota(() => conOrg(app, D, (c) => consumirEjecucion(c, PER))));

    console.log("\n13. Entitlement booleano (exportar código):");
    check("base NO exporta", (await conOrg(app, A, (c) => puedeExportar(c))) === false);
    check("equipo SÍ exporta", (await conOrg(app, E, (c) => puedeExportar(c))) === true);
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, E, C, D]]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ M3 (enforcement de cuotas EN LA BD) PROBADO" : "✗ FALLÓ"} — sin oversell, sin auto-ascenso, sin reset, fail-closed.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("Error:", e);
  console.error("¿Postgres con el schema M3 aplicado (planes/subscriptions/uso_periodo, triggers, app_consumir) y rol automata_app?");
  process.exit(1);
});
