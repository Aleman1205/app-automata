// ─────────────────────────────────────────────────────────────────────────────
// Verificación de los incidentes durables (a2). Prueba: grants (el app no toca la tabla,
// solo el SD), anti-forge (el contexto de org manda sobre p_org), actor=session_user, enum
// validado, append-only, y —lo clave— el FIX DEL RE-BRICK: emitirEnTx envuelve el INSERT en
// un SAVEPOINT, así que un fallo del sink NO aborta la tx (que antes revertía building→lista
// y ladrillaba la automatización). También el camino real de confirmarAjuste sobre 'failed'.
//   ADMIN_URL=... DATABASE_URL=... npm run verify:incidentes:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { registrarIncidente, emitirEnTx, incidentesAbiertos, resolverIncidente } from "../src/ops/incidentes.ts";
import { confirmarAjuste } from "../src/ciclo/servicio.ts";
import type { TipoIncidente } from "../src/ops/incidentes.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AUTO = "e4000000-0000-0000-0000-00000000000a";
const VER = "e4000000-0000-0000-0000-0000000000f1";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const codigoDe = async (fn: () => Promise<unknown>) => { try { await fn(); return "permitido"; } catch (e) { return (e as { code?: string }).code ?? "throw"; } };

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const uno = (sql: string, p: unknown[] = []) => admin.query<Record<string, unknown>>(sql, p).then((r) => r.rows[0]);
  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]);
    await admin.query("DELETE FROM incidentes WHERE org_id = ANY($1) OR org_id IS NULL AND detalle LIKE 'test:%'", [[A, B]]);
    for (const o of [A, B]) { await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [o]); await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [o]); }
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'a')", [AUTO, A]);

    console.log("1. Grants: el app NO toca la tabla; solo emite por el SD:");
    check("INSERT directo en incidentes como app → 42501", (await conOrg(app, A, (c) => codigoDe(() => c.query("INSERT INTO incidentes (tipo) VALUES ('otro')")))) === "42501");
    check("UPDATE incidentes como app → 42501 (append-only)", (await conOrg(app, A, (c) => codigoDe(() => c.query("UPDATE incidentes SET nota='x'")))) === "42501");
    check("DELETE incidentes como app → 42501 (append-only)", (await conOrg(app, A, (c) => codigoDe(() => c.query("DELETE FROM incidentes")))) === "42501");
    check("EXECUTE del SD como app → permitido", (await conOrg(app, A, (c) => codigoDe(() => registrarIncidente(c, { tipo: "otro", detalle: "test: app ok" })))) === "permitido");

    console.log("\n2. Anti-forge + actor:");
    // Bajo contexto A, aunque se pase p_org=B, la org atribuida es A (app_current_org manda).
    await conOrg(app, A, (c) => c.query("SELECT app_registrar_incidente('otro','baja',$1,NULL,NULL,'test: antiforge')", [B]));
    const forjado = await uno("SELECT org_id::text AS org, actor FROM incidentes WHERE detalle='test: antiforge'");
    check("app bajo conOrg(A) con p_org=B → se atribuye a A (no se puede forjar org)", forjado?.["org"] === A);
    check("actor = session_user del app (automata_app), no el dueño DEFINER", forjado?.["actor"] === "automata_app");
    // Sin contexto (owner) sí usa p_org.
    await registrarIncidente(admin, { tipo: "webhook_desconocido", orgId: B, detalle: "test: owner p_org" });
    const owner = await uno("SELECT org_id::text AS org, actor FROM incidentes WHERE detalle='test: owner p_org'");
    check("owner sin contexto usa el p_org pasado (B)", owner?.["org"] === B);
    check("actor del owner = postgres (session_user real)", owner?.["actor"] === "postgres");

    console.log("\n3. Enum validado + org NULL permitido:");
    check("tipo inválido → RAISE (CHECK, 23514)", (await conOrg(app, A, (c) => codigoDe(() => c.query("SELECT app_registrar_incidente('tipo_malo','media',NULL,NULL,NULL,'x')")))) === "23514");
    await registrarIncidente(admin, { tipo: "webhook_desconocido", detalle: "test: sin org" }); // org NULL ok
    check("incidente con org_id NULL permitido (webhook pre-resolución)", (await uno("SELECT count(*)::int AS n FROM incidentes WHERE detalle='test: sin org' AND org_id IS NULL"))?.["n"] === 1);

    console.log("\n4. FIX DEL RE-BRICK: emitirEnTx con sink que falla NO aborta la tx:");
    const vivo = await conOrg(app, A, async (c) => {
      await emitirEnTx(c, { tipo: "tipo_malo" as TipoIncidente, detalle: "forzar fallo del sink" }); // SD RAISE → SAVEPOINT rollback
      return (await c.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok; // la tx DEBE seguir viva
    });
    check("un fallo del sink dentro de emitirEnTx deja la tx utilizable (SAVEPOINT)", vivo === 1);

    console.log("\n5. Camino real: confirmarAjuste sobre 'failed' emite incidente y NO lanza:");
    await admin.query("INSERT INTO versiones (id,automatizacion_id,org_id,numero,estado) VALUES ($1,$2,$3,1,'building')", [VER, AUTO, A]);
    await admin.query("UPDATE versiones SET estado='failed' WHERE id=$1", [VER]); // reaper la mató
    const estado = await conOrg(app, A, (c) => confirmarAjuste(c, AUTO, VER)); // no debe lanzar
    check("confirmarAjuste sobre 'failed' retorna (no lanza)", typeof estado === "object");
    check("...y dejó un incidente 'pago_no_entregado' de esa versión", (await uno("SELECT count(*)::int AS n FROM incidentes WHERE version_id=$1 AND tipo='pago_no_entregado'", [VER]))?.["n"] === 1);

    console.log("\n6. Panel de ops (pull-based):");
    const abiertos = await incidentesAbiertos(admin);
    check("incidentesAbiertos trae los no resueltos (varios)", abiertos.length >= 4);
    check("ordenados por severidad (el primero no es 'baja' si hay altas)", abiertos[0]?.severidad !== "baja");
    const alguno = abiertos[0]!;
    await resolverIncidente(admin, alguno.id, "ops-test", "atendido");
    check("resolverIncidente lo cierra (sale de abiertos)", (await incidentesAbiertos(admin)).every((i) => i.id !== alguno.id));
  } finally {
    await admin.query("DELETE FROM incidentes WHERE org_id = ANY($1) OR detalle LIKE 'test:%'", [[A, B]]).catch(() => {});
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ INCIDENTES PROBADOS" : "✗ FALLÓ"} — durables vía SD (append-only, anti-forge, actor real), y emitirEnTx no ladrilla la tx si el sink falla.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
