// ─────────────────────────────────────────────────────────────────────────────
// Verificación del cambio de plan / downgrade (docs/06 §9) contra Postgres. Al bajar
// de plan, el excedente queda activa=false (solo lectura, conservando las más antiguas)
// atómicamente; la reactivación la enforza el trigger de espacios de M3 (sin oversell,
// TOCTOU-safe). Downgrade = conexión de DUEÑO; reactivar/desactivar = conOrg (rol app).
//   ADMIN_URL=... DATABASE_URL=... npm run verify:plan:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { aplicarDowngrade, reactivar, desactivar, usoDeEspacios, AutomatizacionNoEncontrada } from "../src/billing/plan.ts";
import { CuotaExcedida, crearAutomatizacion } from "../src/billing/cuota.ts";
import { type Pool, type PoolClient } from "pg";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTRA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const au = (n: number) => `d1000000-0000-0000-0000-00000000000${n}`;

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const lanza = async (fn: () => Promise<unknown>, clase: new (...a: never[]) => Error) => {
  try { await fn(); return false; } catch (e) { return e instanceof clase; }
};
async function abrirTx(pool: Pool, org: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE automata_app");
  await c.query("SELECT set_config('app.current_org', $1, true)", [org]);
  return c;
}
const cerrar = async (c: PoolClient, cmd: "COMMIT" | "ROLLBACK") => { await c.query(cmd).catch(() => {}); c.release(); };

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const activas = () => conOrg(app, A, (c) => c.query<{ n: number }>("SELECT count(*)::int AS n FROM automatizaciones WHERE activa").then((r) => r.rows[0]?.n ?? 0));
  const estaActiva = (n: number) => admin.query<{ activa: boolean }>("SELECT activa FROM automatizaciones WHERE id=$1", [au(n)]).then((r) => r.rows[0]?.activa === true);
  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, OTRA]]);
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'a'),($2,'o')", [A, OTRA]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo'),($2,'base')", [A, OTRA]);
    for (let n = 1; n <= 5; n++) await admin.query("INSERT INTO automatizaciones (id,org_id,nombre,creada) VALUES ($1,$2,$3,$4)", [au(n), A, `auto${n}`, `2026-01-0${n} 00:00:00+00`]);
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'ajena')", [au(9), OTRA]);

    console.log("1. Downgrade equipo(10)→base(3) con 5 activas: desactiva el excedente:");
    check("antes: 5 activas de 10", (await conOrg(app, A, (c) => usoDeEspacios(c))).activas === 5);
    const d = await aplicarDowngrade(admin, A, "base");
    check("desactiva las 2 MÁS NUEVAS (auto4, auto5), conserva las 3 más antiguas", d.desactivadas.length === 2 && d.desactivadas.includes(au(4)) && d.desactivadas.includes(au(5)));
    check("auto1..3 siguen activas; auto4,5 en solo lectura", (await estaActiva(1)) && (await estaActiva(3)) && !(await estaActiva(4)) && !(await estaActiva(5)));
    const uso = await conOrg(app, A, (c) => usoDeEspacios(c));
    check("uso de espacios ahora 3 de 3 (plan base)", uso.activas === 3 && uso.limite === 3);

    console.log("\n2. Reactivar (trigger de M3): sin espacio → CuotaExcedida; libera y reactiva:");
    check("reactivar auto4 con el plan LLENO (3/3) → CuotaExcedida('espacios')", await lanza(() => conOrg(app, A, (c) => reactivar(c, au(4))), CuotaExcedida));
    await conOrg(app, A, (c) => desactivar(c, au(1))); // libera un espacio (2/3)
    check("tras desactivar auto1 → 2 activas", (await activas()) === 2);
    await conOrg(app, A, (c) => reactivar(c, au(4))); // ahora sí cabe
    check("reactivar auto4 con espacio → activa; auto1 quedó inactiva", (await estaActiva(4)) && !(await estaActiva(1)) && (await activas()) === 3);
    await conOrg(app, A, (c) => reactivar(c, au(4))); // ya activa
    check("reactivar una ya activa → idempotente (sigue 3)", (await activas()) === 3);

    console.log("\n3. Guardas de acceso:");
    check("reactivar automatización de OTRA org → AutomatizacionNoEncontrada (RLS)", await lanza(() => conOrg(app, A, (c) => reactivar(c, au(9))), AutomatizacionNoEncontrada));
    check("desactivar id inexistente → AutomatizacionNoEncontrada", await lanza(() => conOrg(app, A, (c) => desactivar(c, "00000000-0000-0000-0000-000000000000")), AutomatizacionNoEncontrada));
    check("el rol de app NO puede cambiar el plan (UPDATE subscriptions → permission denied 42501)", await (async () => {
      try { await conOrg(app, A, (c) => c.query("UPDATE subscriptions SET plan='equipo'")); return false; } catch (e) { return (e as { code?: string }).code === "42501"; }
    })());

    console.log("\n4. Downgrade que NO recorta (a plan igual/mayor):");
    // Estado: base, 3 activas (auto2,3,4). Subir a equipo(10) no desactiva nada.
    const up = await aplicarDowngrade(admin, A, "equipo");
    check("subir a equipo(10) con 3 activas → 0 desactivadas", up.desactivadas.length === 0 && (await activas()) === 3);

    console.log("\n5. TOCTOU: dos reactivaciones concurrentes por el ÚLTIMO espacio:");
    // Volver a base (3), dejar 2 activas → 1 espacio libre; auto1 y auto5 inactivas.
    await aplicarDowngrade(admin, A, "base"); // 3 activas (auto2,3,4)
    await conOrg(app, A, (c) => desactivar(c, au(2))); // 2 activas (auto3,4); auto1,2,5 inactivas
    const t1 = await abrirTx(app, A);
    await reactivar(t1, au(1)); // toma el advisory lock, activa (sin commit) → 3
    const t2 = await abrirTx(app, A);
    const p2 = reactivar(t2, au(5)).then(() => "ok").catch((e) => e); // BLOQUEA en el advisory lock
    const pend5 = await Promise.race([p2.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 150))]);
    await cerrar(t1, "COMMIT"); // libera → p2 ve 3 >= 3
    const r2 = await p2;
    await cerrar(t2, "ROLLBACK");
    check("el 2º reactivar BLOQUEA hasta el commit del 1º", pend5 === true);
    check("el 2º concurrente es cortado (CuotaExcedida)", r2 instanceof CuotaExcedida);
    check("final: exactamente 3 activas, sin oversell a 4", (await activas()) === 3);

    console.log("\n6. OVERSELL: downgrade (dueño) vs crearAutomatizacion (app) concurrente:");
    // Reset: A en equipo, 3 activas (auto1,2,3).
    await admin.query("DELETE FROM automatizaciones WHERE org_id=$1", [A]);
    await admin.query("UPDATE subscriptions SET plan='equipo' WHERE org_id=$1", [A]);
    for (let n = 1; n <= 3; n++) await admin.query("INSERT INTO automatizaciones (id,org_id,nombre,creada) VALUES ($1,$2,$3,$4)", [au(n), A, `a${n}`, `2026-01-0${n} 00:00:00+00`]);
    const tCrea = await abrirTx(app, A);
    await crearAutomatizacion(tCrea, "nueva"); // trigger: plan equipo(10), 3<10 OK; toma el advisory lock (sin commit)
    const pDG = aplicarDowngrade(admin, A, "base").then((d) => d).catch((e) => e); // debe BLOQUEAR en el mismo lock
    const pendDG = await Promise.race([pDG.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 150))]);
    await cerrar(tCrea, "COMMIT"); // libera → el downgrade sigue y ve la 4ª activa
    await pDG;
    check("aplicarDowngrade BLOQUEA mientras un create concurrente tiene el lock", pendDG === true);
    check("tras el downgrade concurrente: activas ≤ espacios del plan nuevo (sin oversell)", (await activas()) <= 3);

    console.log("\n7. Guardas de aplicarDowngrade y determinismo:");
    check("plan inexistente → error", await (async () => { try { await aplicarDowngrade(admin, A, "gratis"); return false; } catch { return true; } })());
    check("org sin subscription → error (no desactiva nada)", await (async () => {
      await admin.query("INSERT INTO orgs (id,nombre) VALUES ('99999999-9999-9999-9999-999999999999','sinsub')");
      try { await aplicarDowngrade(admin, "99999999-9999-9999-9999-999999999999", "base"); return false; } catch { return true; }
      finally { await admin.query("DELETE FROM orgs WHERE id='99999999-9999-9999-9999-999999999999'"); }
    })());
    // creada empatada → el tiebreaker id ASC hace la elección determinista.
    await admin.query("DELETE FROM automatizaciones WHERE org_id=$1", [A]);
    await admin.query("UPDATE subscriptions SET plan='equipo' WHERE org_id=$1", [A]);
    for (let n = 1; n <= 4; n++) await admin.query("INSERT INTO automatizaciones (id,org_id,nombre,creada) VALUES ($1,$2,$3,'2026-05-05 00:00:00+00')", [au(n), A, `t${n}`]);
    const dTie = await aplicarDowngrade(admin, A, "base"); // creada igual → conserva id ASC 1,2,3; desactiva au(4)
    check("con creada empatada, desactiva de forma determinista (id ASC) → au(4)", dTie.desactivadas.length === 1 && dTie.desactivadas[0] === au(4));
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, OTRA]]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ CAMBIO DE PLAN / DOWNGRADE PROBADO" : "✗ FALLÓ"} — excedente en solo lectura atómico, reactivación trigger-enforced sin oversell.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
