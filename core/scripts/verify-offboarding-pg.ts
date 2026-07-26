// ─────────────────────────────────────────────────────────────────────────────
// Verificación de purgarOrg (a1-s2): la baja DEFINITIVA de un tenant (offboarding/GDPR).
// Es el ÚNICO camino de borrado de una org (el app tiene REVOKE DELETE/INSERT ON orgs).
// Prueba: (1) el CASCADE arrasa TODOS los hijos, (2) el asiento 'purgar' de bitacora_kill
// SOBREVIVE (no tiene FK a orgs), (3) una org vecina queda intacta, (4) purgar una org
// inexistente lanza, (5) el rol de app NO puede borrar orgs (solo el dueño purga).
//   ADMIN_URL=... DATABASE_URL=... npm run verify:offboarding:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { purgarOrg } from "../src/ops/killswitch.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AUTO_A = "a0000000-0000-0000-0000-0000000000a1";
const VER_A = "a0000000-0000-0000-0000-0000000000f1";
const AUTO_B = "b0000000-0000-0000-0000-0000000000b1";
const VER_B = "b0000000-0000-0000-0000-0000000000f2";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

const TABLAS_HIJAS = ["memberships", "automatizaciones", "versiones", "ejecuciones", "subscriptions", "uso_periodo", "suspensiones"] as const;

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);

  const hijos = async (org: string) => {
    let total = 0;
    const detalle: Record<string, number> = {};
    for (const t of TABLAS_HIJAS) {
      const r = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE org_id = $1`, [org]);
      const n = r.rows[0]?.n ?? 0;
      detalle[t] = n; total += n;
    }
    return { total, detalle };
  };
  const cuenta = async (sql: string, params: unknown[]) => (await admin.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0;

  try {
    // ── Semilla: org A con TODOS los tipos de hijo + un asiento previo de bitácora ──
    for (const o of [A, B]) await admin.query("DELETE FROM orgs WHERE id = $1", [o]);
    await admin.query("DELETE FROM bitacora_kill WHERE org_id = ANY($1)", [[A, B]]);
    for (const [o, auto, ver] of [[A, AUTO_A, VER_A], [B, AUTO_B, VER_B]] as const) {
      await admin.query("INSERT INTO orgs (id, nombre) VALUES ($1,$2)", [o, `Org ${o[0]}`]);
      await admin.query("INSERT INTO subscriptions (org_id, plan, estado) VALUES ($1,'equipo','activa')", [o]);
      await admin.query("INSERT INTO memberships (org_id, user_id, rol) VALUES ($1,'u_admin','admin'), ($1,'u_op','operador')", [o]);
      await admin.query("INSERT INTO automatizaciones (id, org_id, nombre) VALUES ($1,$2,'Auto')", [auto, o]);
      await admin.query("INSERT INTO versiones (id, automatizacion_id, org_id, numero, estado) VALUES ($1,$2,$3,1,'lista')", [ver, auto, o]); // cobrar_build → uso_periodo
      await admin.query("INSERT INTO ejecuciones (version_id, org_id, estado, ms) VALUES ($1,$2,'ok',100)", [ver, o]); // cobrar_ejecucion
      await admin.query("INSERT INTO uso_periodo (org_id, periodo, generaciones, ejecuciones) VALUES ($1, to_char(now(),'YYYY-MM'), 1, 1) ON CONFLICT (org_id,periodo) DO UPDATE SET generaciones=1", [o]);
      await admin.query("INSERT INTO suspensiones (org_id, motivo) VALUES ($1,'prueba') ON CONFLICT (org_id) DO NOTHING", [o]);
    }
    // Asiento previo de bitácora para A (una suspensión pasada): debe sobrevivir la purga.
    await admin.query("INSERT INTO bitacora_kill (actor, accion, palanca, org_id, motivo) VALUES ('ops','suspender','org',$1,'incidente viejo')", [A]);

    console.log("Estado inicial:");
    const antesA = await hijos(A);
    console.log(`  org A: ${JSON.stringify(antesA.detalle)}`);
    check("A arranca con hijos en TODAS las tablas org-scoped", TABLAS_HIJAS.every((t) => (antesA.detalle[t] ?? 0) > 0));
    check("bitácora de A tiene el asiento previo (suspender)", (await cuenta("SELECT count(*)::int AS n FROM bitacora_kill WHERE org_id=$1", [A])) === 1);

    console.log("\n1. purgarOrg(A) — CASCADE + asiento que sobrevive:");
    await purgarOrg(admin, A, "ops-offboarding-test");
    const despuesA = await hijos(A);
    check("todos los hijos de A quedaron en 0 (CASCADE completo)", despuesA.total === 0);
    check("la fila de orgs A ya no existe", (await cuenta("SELECT count(*)::int AS n FROM orgs WHERE id=$1", [A])) === 0);
    check("el asiento 'purgar' de A SOBREVIVE (bitacora sin FK)", (await cuenta("SELECT count(*)::int AS n FROM bitacora_kill WHERE org_id=$1 AND accion='purgar'", [A])) === 1);
    check("el asiento PREVIO ('suspender') de A también sobrevive (evidencia intacta)", (await cuenta("SELECT count(*)::int AS n FROM bitacora_kill WHERE org_id=$1 AND accion='suspender'", [A])) === 1);

    console.log("\n2. La org vecina B queda INTACTA:");
    check("orgs B sigue existiendo", (await cuenta("SELECT count(*)::int AS n FROM orgs WHERE id=$1", [B])) === 1);
    const despuesB = await hijos(B);
    check("los hijos de B siguen intactos (nada se arrastró)", TABLAS_HIJAS.every((t) => (despuesB.detalle[t] ?? 0) > 0));

    console.log("\n3. Robustez y autorización:");
    let lanzoInexistente = false;
    try { await purgarOrg(admin, "cccccccc-cccc-cccc-cccc-cccccccccccc", "x"); } catch { lanzoInexistente = true; }
    check("purgar una org inexistente LANZA (rowCount 0, rollback)", lanzoInexistente);
    check("el asiento de la org inexistente se revirtió (rollback atómico)", (await cuenta("SELECT count(*)::int AS n FROM bitacora_kill WHERE org_id='cccccccc-cccc-cccc-cccc-cccccccccccc'", [])) === 0);
    const delApp = await conOrg(app, B, async (c) => {
      try { await c.query("DELETE FROM orgs WHERE id = $1", [B]); return "permitido"; }
      catch (e) { return (e as { code?: string }).code; }
    });
    check("el rol de app NO puede purgar (DELETE orgs → 42501): solo el dueño", delApp === "42501");
  } finally {
    for (const o of [A, B]) await admin.query("DELETE FROM orgs WHERE id = $1", [o]).catch(() => {});
    await admin.query("DELETE FROM bitacora_kill WHERE org_id = ANY($1)", [[A, B]]).catch(() => {});
    await admin.end(); await app.end();
  }

  console.log(`\n${ok ? "✓ OFFBOARDING PROBADO" : "✗ FALLÓ"} — purgarOrg es owner-only, arrasa los hijos por CASCADE, conserva la evidencia en bitacora_kill, y no toca a las demás orgs.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
