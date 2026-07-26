// ─────────────────────────────────────────────────────────────────────────────
// Verificación de la COSECHA (a3-s1/s3) contra Postgres, con cosechador y storage FALSOS
// (sin CMA ni R2). Prueba: satisfecho→'lista'+artefacto+consume ajuste; GUARD DE BYTES
// (put que no persiste → NO se marca 'lista', incidente); fallido→'failed'; en_curso→se deja;
// idempotencia; drenarCosecha end-to-end; y la seguridad del build-start (fijarSesionCma
// write-once, el app no puede INSERTAR cma_session_id).
//   ADMIN_URL=... DATABASE_URL=... npm run verify:cosecha:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { PgStateRepo } from "../src/state/pg.ts";
import { cosecharYConfirmar, drenarCosecha, type CosechaDeps } from "../src/pipeline/cosecha.ts";
import type { BuildClientAsync, ResultadoCosecha, Storage, Vista } from "../src/types.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AUTO = "e5000000-0000-0000-0000-00000000000a";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const vista: Vista = { version_vista: 1, titulo: "demo", archivoSalida: "out.json", bloques: [] };
const codigo = { automatizacionPy: "print('ok')", manifiesto: { entradas: [] } };

class FakeStorage implements Storage {
  m = new Map<string, string>();
  fallarPut = false; // modo: put no persiste (para el guard de bytes)
  async put(k: string, d: Buffer | string) { if (!this.fallarPut) this.m.set(k, typeof d === "string" ? d : d.toString("utf8")); }
  async get(k: string) { return Buffer.from(this.m.get(k) ?? ""); }
  async getText(k: string) { const v = this.m.get(k); if (v === undefined) throw new Error("no"); return v; }
  async existe(k: string) { return this.m.has(k); }
  async list(p: string) { return [...this.m.keys()].filter((k) => k.startsWith(p)); }
}
class FakeCosechador implements BuildClientAsync {
  r = new Map<string, ResultadoCosecha>();
  async build(): Promise<never> { throw new Error("no usado"); }
  async arrancar(): Promise<never> { throw new Error("no usado"); }
  async cosechar(sid: string): Promise<ResultadoCosecha> { return this.r.get(sid) ?? { estado: "en_curso" }; }
}

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const storage = new FakeStorage();
  const cosechador = new FakeCosechador();
  const deps: CosechaDeps = { pool: admin, cosechador, storage };
  const uno = (sql: string, p: unknown[] = []) => admin.query<Record<string, unknown>>(sql, p).then((r) => r.rows[0]);
  // Siembra una versión 'building' con vista + cma_session_id + su fila de outbox.
  const sembrar = async (sid: string, numero: number) => {
    const v = await admin.query<{ id: string }>("INSERT INTO versiones (automatizacion_id, org_id, numero, estado, tipo, cma_session_id, vista) VALUES ($1,$2,$3,'building','cambio',$4,$5) RETURNING id", [AUTO, A, numero, sid, JSON.stringify(vista)]);
    const vid = v.rows[0]!.id;
    await admin.query("INSERT INTO cosecha_pendiente (session_id, version_id, auto_id, org_id) VALUES ($1,$2,$3,$4)", [sid, vid, AUTO, A]);
    return vid;
  };
  const estadoVer = (vid: string) => uno("SELECT estado, artefacto_key AS ak FROM versiones WHERE id=$1", [vid]);
  const enOutbox = (sid: string) => admin.query<{ n: number }>("SELECT count(*)::int AS n FROM cosecha_pendiente WHERE session_id=$1", [sid]).then((r) => r.rows[0]?.n ?? 0);

  try {
    await admin.query("DELETE FROM orgs WHERE id=$1", [A]);
    await admin.query("DELETE FROM cosecha_pendiente WHERE org_id=$1", [A]);
    await admin.query("DELETE FROM incidentes WHERE org_id=$1", [A]);
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [A]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [A]);
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'a')", [AUTO, A]);

    console.log("1. Cosecha SATISFECHA → 'lista' + artefacto en storage + consume ajuste:");
    const v1 = await sembrar("s_ok", 1);
    cosechador.r.set("s_ok", { estado: "satisfecho", codigo, costoUsd: 0, iteraciones: 2 });
    const e1 = await cosecharYConfirmar(deps, { sessionId: "s_ok", versionId: v1, autoId: AUTO, orgId: A });
    check("retorna 'cosechado'", e1 === "cosechado");
    const r1 = await estadoVer(v1);
    check("la versión quedó 'lista'", r1?.["estado"] === "lista");
    check("fijó artefacto_key determinista", r1?.["ak"] === `artefactos/${v1}.json`);
    check("subió el artefacto (con la vista) a storage", storage.m.has(`artefactos/${v1}.json`) && JSON.parse(storage.m.get(`artefactos/${v1}.json`)!).vista.titulo === "demo");
    check("selló la entrega (trg_marcar_entrega) al pasar a 'lista'", (await uno("SELECT entregada IS NOT NULL AS e FROM automatizaciones WHERE id=$1", [AUTO]))?.["e"] === true);

    console.log("\n2. GUARD DE BYTES: put que NO persiste → NO se marca 'lista' + incidente:");
    const v2 = await sembrar("s_nobytes", 2);
    cosechador.r.set("s_nobytes", { estado: "satisfecho", codigo, costoUsd: 0, iteraciones: 1 });
    storage.fallarPut = true;
    const e2 = await cosecharYConfirmar(deps, { sessionId: "s_nobytes", versionId: v2, autoId: AUTO, orgId: A });
    storage.fallarPut = false;
    check("retorna 'sin_bytes'", e2 === "sin_bytes");
    check("la versión sigue 'building' (no 'lista' sin artefacto ejecutable)", (await estadoVer(v2))?.["estado"] === "building");
    check("dejó incidente 'cosecha_fallida'", (await uno("SELECT count(*)::int AS n FROM incidentes WHERE tipo='cosecha_fallida' AND version_id=$1", [v2]))?.["n"] === 1);

    console.log("\n3. Cosecha FALLIDA → 'failed':");
    const v3 = await sembrar("s_fail", 3);
    cosechador.r.set("s_fail", { estado: "fallido", motivo: "grader: max_iterations_reached", iteraciones: 4 });
    check("retorna 'fallido'", (await cosecharYConfirmar(deps, { sessionId: "s_fail", versionId: v3, autoId: AUTO, orgId: A })) === "fallido");
    check("la versión quedó 'failed'", (await estadoVer(v3))?.["estado"] === "failed");

    console.log("\n4. Cosecha EN CURSO → se deja (reintento):");
    const v4 = await sembrar("s_curso", 4);
    cosechador.r.set("s_curso", { estado: "en_curso" });
    check("retorna 'en_curso'", (await cosecharYConfirmar(deps, { sessionId: "s_curso", versionId: v4, autoId: AUTO, orgId: A })) === "en_curso");
    check("la versión sigue 'building'", (await estadoVer(v4))?.["estado"] === "building");

    console.log("\n5. Idempotencia: cosechar de nuevo una ya 'lista' no doble-consume:");
    const aj = (await uno("SELECT ajustes_usados AS n FROM automatizaciones WHERE id=$1", [AUTO]))?.["n"];
    const e5 = await cosecharYConfirmar(deps, { sessionId: "s_ok", versionId: v1, autoId: AUTO, orgId: A });
    check("retorna 'cosechado' (no-op)", e5 === "cosechado");
    check("no volvió a consumir ajuste", (await uno("SELECT ajustes_usados AS n FROM automatizaciones WHERE id=$1", [AUTO]))?.["n"] === aj);

    console.log("\n6. drenarCosecha end-to-end (borra las terminales, deja las pendientes):");
    // s_ok ya está 'lista' pero su fila de outbox sigue; s_fail 'failed'; s_curso 'building'; s_nobytes building.
    const res = await drenarCosecha(deps, { lote: 20 });
    check(`drenó: cosechados=${res.cosechados} fallidos=${res.fallidos} pendientes=${res.pendientes}`, res.cosechados >= 2 && res.fallidos >= 1 && res.pendientes >= 1);
    check("s_ok salió del outbox (ya 'lista', no-op terminal)", (await enOutbox("s_ok")) === 0);
    check("s_fail salió del outbox (terminal)", (await enOutbox("s_fail")) === 0);
    check("s_nobytes salió del outbox (reintento exitoso: el put ya funciona)", (await enOutbox("s_nobytes")) === 0);
    check("s_curso sigue en el outbox (en_curso, pendiente de reintento)", (await enOutbox("s_curso")) === 1);
    check("cada fila se procesó UNA vez por drenado (sin bucle de re-reclamo)", res.cosechados + res.fallidos + res.pendientes === 4);

    console.log("\n7. Seguridad del build-start (a3-s1): cma_session_id write-once, no lo inserta el app:");
    const repo = new PgStateRepo(app, A);
    const vFresh = await admin.query<{ id: string }>("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,10,'building') RETURNING id", [AUTO, A]);
    const vid = vFresh.rows[0]!.id;
    await repo.fijarSesionCma(vid, "sess_nueva");
    check("fijarSesionCma graba la sesión (1ª vez)", (await uno("SELECT cma_session_id AS s FROM versiones WHERE id=$1", [vid]))?.["s"] === "sess_nueva");
    let reFijo = false;
    try { await repo.fijarSesionCma(vid, "otra"); } catch { reFijo = true; }
    check("2ª fijarSesionCma → SESION_CMA_NO_FIJABLE (write-once)", reFijo);
    const insDirecto = await conOrg(app, A, async (c) => {
      try { await c.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,cma_session_id) VALUES ($1,app_current_org(),11,'building','pre_claim')", [AUTO]); return "permitido"; }
      catch (e) { return (e as { code?: string }).code; }
    });
    check("el app NO puede INSERTAR cma_session_id (columna fuera del GRANT) → 42501", insDirecto === "42501");
  } finally {
    await admin.query("DELETE FROM cosecha_pendiente WHERE org_id=$1", [A]).catch(() => {});
    await admin.query("DELETE FROM incidentes WHERE org_id=$1", [A]).catch(() => {});
    await admin.query("DELETE FROM orgs WHERE id=$1", [A]).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ COSECHA PROBADA" : "✗ FALLÓ"} — el drainer cierra el loop async: ensambla con la vista, guard de bytes, confirma/falla idempotente, y el build-start blinda cma_session_id.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
