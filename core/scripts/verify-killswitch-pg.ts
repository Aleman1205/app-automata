// ─────────────────────────────────────────────────────────────────────────────
// Verificación del kill-switch (docs/14 §3 / docs/11 §10) contra Postgres: congela
// builds y ejecuciones "de verdad" (guard temprano + triggers), suspende una org
// quirúrgicamente, el rol de app NO puede apagarlo NI evadirlo (RLS + REVOKE), falla
// CERRADO si falta la fila del interruptor, y el dueño puede remediar y queda bitácora.
// La palanca de cobros es separada. Es el caso del checklist §10 "probarlo en staging".
//   ADMIN_URL=... DATABASE_URL=... npm run verify:killswitch:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { iniciarAjuste } from "../src/ciclo/servicio.ts";
import {
  congelar, descongelar, suspenderOrg, reactivarOrg, estado,
  cobrosCongelados, verificarFreno, exigirCobrosActivos, ServicioSuspendido,
} from "../src/ops/killswitch.ts";
import { type Pool } from "pg";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const autoA = "e1000000-0000-0000-0000-00000000000a";
const autoB = "e1000000-0000-0000-0000-00000000000b";
const verA = "f1000000-0000-0000-0000-00000000000a";
const verB = "f1000000-0000-0000-0000-00000000000b";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const esSuspension = async (fn: () => Promise<unknown>, motivo: string) => {
  try { await fn(); return false; } catch (e) { return e instanceof ServicioSuspendido && e.motivo === motivo; }
};
const mensaje = async (fn: () => Promise<unknown>, re: RegExp) => {
  try { await fn(); return false; } catch (e) { return re.test((e as Error).message); }
};
const codigo = async (fn: () => Promise<unknown>, code: string) => {
  try { await fn(); return false; } catch (e) { return (e as { code?: string }).code === code; }
};
const lanza = async (fn: () => Promise<unknown>) => {
  try { await fn(); return false; } catch { return true; }
};

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  // build/run EN-CONTEXTO (rol app), que es lo que el kill-switch debe frenar. El
  // trigger trg_kill_build dispara en el INSERT sin importar el `estado`, así que el
  // build crudo inserta 'lista' (no 'building'): prueba el freno sin dejar una versión
  // "en vuelo" que haría saltar la guarda anti-spam de iniciarAjuste (AjusteEnCurso).
  const build = (org: string, autoId: string, numero: number) => conOrg(app, org, (c) => c.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,$3,'lista')", [autoId, org, numero]));
  const run = (org: string, verId: string) => conOrg(app, org, (c) => c.query("INSERT INTO ejecuciones (version_id, org_id, estado, ms) VALUES ($1,$2,'ok',100)", [verId, org]));
  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]);
    await admin.query("INSERT INTO interruptores (id) VALUES (true) ON CONFLICT (id) DO UPDATE SET builds=false, ejecuciones=false, cobros=false");
    await admin.query("DELETE FROM bitacora_kill");
    for (const [o, au, ve] of [[A, autoA, verA], [B, autoB, verB]] as const) {
      await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [o]);
      await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'base')", [o]);
      await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'a')", [au, o]);
      await admin.query("INSERT INTO versiones (id,automatizacion_id,org_id,numero,estado) VALUES ($1,$2,$3,1,'lista')", [ve, au, o]);
    }

    console.log("0. Baseline (todo abierto, sin suspensión): build y run PROCEDEN:");
    check("build en-contexto rowCount === 1", (await build(A, autoA, 5)).rowCount === 1);
    check("run en-contexto rowCount === 1", (await run(A, verA)).rowCount === 1);
    check("verificarFreno('builds'/'ejecuciones') no lanza abierto", !(await lanza(() => conOrg(app, A, (c) => verificarFreno(c, "ejecuciones")))));

    console.log("\n1. Congelar BUILDS globalmente:");
    await congelar(admin, "builds", "ops:test");
    check("build en-contexto (raw INSERT versiones) → bloqueado", await mensaje(() => build(A, autoA, 10), /SERVICIO_SUSPENDIDO:builds/));
    check("iniciarAjuste con builds congelados → ServicioSuspendido('builds')", await esSuspension(() => conOrg(app, A, (c) => iniciarAjuste(c, autoA, "pasa")), "builds"));
    check("las EJECUCIONES no se ven afectadas por el freno de builds", (await run(A, verA)).rowCount === 1);
    await descongelar(admin, "builds", "ops:test");
    check("tras descongelar, el build procede", (await build(A, autoA, 10)).rowCount === 1);

    console.log("\n2. Congelar EJECUCIONES globalmente (guard temprano + trigger):");
    await congelar(admin, "ejecuciones", "ops:test");
    check("run en-contexto (INSERT ejecuciones) → bloqueado (trigger backstop)", await mensaje(() => run(A, verA), /SERVICIO_SUSPENDIDO:ejecuciones/));
    check("verificarFreno('ejecuciones') → ServicioSuspendido ANTES de correr (guard)", await esSuspension(() => conOrg(app, A, (c) => verificarFreno(c, "ejecuciones")), "ejecuciones"));
    check("los BUILDS no se ven afectados", (await build(A, autoA, 11)).rowCount === 1);
    await descongelar(admin, "ejecuciones", "ops:test");
    check("tras descongelar, la ejecución procede", (await run(A, verA)).rowCount === 1);

    console.log("\n3. Suspensión POR-ORG (freeze quirúrgico de un tenant):");
    await suspenderOrg(admin, A, "abuso", "ops:test");
    check("org A suspendida: build bloqueado", await mensaje(() => build(A, autoA, 12), /SERVICIO_SUSPENDIDO:org/));
    check("org A suspendida: run bloqueado", await mensaje(() => run(A, verA), /SERVICIO_SUSPENDIDO:org/));
    check("org A suspendida: iniciarAjuste → ServicioSuspendido('org')", await esSuspension(() => conOrg(app, A, (c) => iniciarAjuste(c, autoA, "pasa")), "org"));
    check("org A suspendida: verificarFreno('ejecuciones') → ServicioSuspendido('org')", await esSuspension(() => conOrg(app, A, (c) => verificarFreno(c, "ejecuciones")), "org"));
    check("org B (no suspendida) sigue operando", (await build(B, autoB, 20)).rowCount === 1);
    await reactivarOrg(admin, A, "ops:test");
    check("tras reactivar la org A, opera de nuevo", (await build(A, autoA, 13)).rowCount === 1);

    console.log("\n4. El rol de app NO puede apagar el freno NI des-suspenderse:");
    await congelar(admin, "builds", "ops:test");
    await suspenderOrg(admin, A, "abuso", "ops:test");
    check("app UPDATE interruptores → 42501", await codigo(() => conOrg(app, A, (c) => c.query("UPDATE interruptores SET builds=false")), "42501"));
    check("app DELETE interruptores (borrar el freno) → 42501", await codigo(() => conOrg(app, A, (c) => c.query("DELETE FROM interruptores")), "42501"));
    check("app INSERT en suspensiones → 42501", await codigo(() => conOrg(app, A, (c) => c.query("INSERT INTO suspensiones (org_id) VALUES ($1)", [A])), "42501"));
    check("app DELETE suspensiones (auto-des-suspenderse) → 42501", await codigo(() => conOrg(app, A, (c) => c.query("DELETE FROM suspensiones WHERE org_id = $1", [A])), "42501"));
    await reactivarOrg(admin, A, "ops:test");

    console.log("\n5. El guard NO es evadible manipulando app.current_org (RLS lo blinda):");
    // builds congelados; dentro de conOrg(app,A) intentamos evadir el guard cambiando
    // el contexto. El skip del guard (org_id ≠ app_current_org) es el complemento EXACTO
    // del WITH CHECK de RLS (org_id = app_current_org) → todo insert que el guard salta,
    // RLS lo rechaza. Ninguno debe insertar (rowCount nunca 1).
    check("app.current_org = '' (NULL) + INSERT versiones org_id=A → rechazado", await lanza(() => conOrg(app, A, async (c) => {
      await c.query("SELECT set_config('app.current_org', '', true)");
      const r = await c.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,90,'building')", [autoA, A]);
      if (r.rowCount === 1) throw new Error("NO DEBERÍA: se insertó evadiendo el guard");
    })));
    check("app.current_org = B + INSERT versiones org_id=A → rechazado por RLS", await lanza(() => conOrg(app, A, async (c) => {
      await c.query("SELECT set_config('app.current_org', $1, true)", [B]);
      const r = await c.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,91,'building')", [autoA, A]);
      if (r.rowCount === 1) throw new Error("NO DEBERÍA: se insertó cross-org");
    })));
    await descongelar(admin, "builds", "ops:test");

    console.log("\n6. Fail-CLOSED si desaparece la fila única de interruptores:");
    await admin.query("DELETE FROM interruptores");
    check("sin fila de interruptores: build en-contexto → BLOQUEADO (no fail-open)", await mensaje(() => build(A, autoA, 40), /SERVICIO_SUSPENDIDO:builds/));
    check("sin fila de interruptores: run en-contexto → BLOQUEADO", await mensaje(() => run(A, verA), /SERVICIO_SUSPENDIDO:ejecuciones/));
    await admin.query("INSERT INTO interruptores (id) VALUES (true) ON CONFLICT (id) DO NOTHING");
    check("restaurada la fila, el build vuelve a proceder", (await build(A, autoA, 41)).rowCount === 1);

    console.log("\n7. El DUEÑO puede remediar durante el incidente (builds congelados):");
    await congelar(admin, "builds", "ops:test");
    const rem = await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,50,'building') RETURNING id", [autoA, A]);
    check("el dueño puede crear una versión aunque builds esté congelado", rem.rowCount === 1);
    await descongelar(admin, "builds", "ops:test");

    console.log("\n8. Palanca separada de COBROS (Stripe), guard y estado:");
    await congelar(admin, "cobros", "ops:test");
    check("cobrosCongelados = true tras la palanca", (await cobrosCongelados(app)) === true);
    check("exigirCobrosActivos → ServicioSuspendido('cobros')", await esSuspension(() => conOrg(app, A, (c) => exigirCobrosActivos(c)), "cobros"));
    check("congelar cobros NO frena los builds", (await build(A, autoA, 14)).rowCount === 1);
    const st = await estado(admin);
    check("estado refleja cobros=true, builds/ejecuciones=false", st.cobros === true && st.builds === false && st.ejecuciones === false);
    await descongelar(admin, "cobros", "ops:test");
    check("cobrosCongelados = false tras descongelar", (await cobrosCongelados(app)) === false);

    console.log("\n9. Bitácora append-only de auditoría:");
    const bit = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM bitacora_kill WHERE actor = 'ops:test'");
    check("las palancas de ops dejaron asiento (quién/cuándo)", (bit.rows[0]?.n ?? 0) > 0);
    check("el rol de app NO puede leer la bitácora del freno → 42501", await codigo(() => conOrg(app, A, (c) => c.query("SELECT * FROM bitacora_kill")), "42501"));
  } finally {
    await admin.query("INSERT INTO interruptores (id) VALUES (true) ON CONFLICT (id) DO UPDATE SET builds=false, ejecuciones=false, cobros=false").catch(() => {});
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ KILL-SWITCH PROBADO" : "✗ FALLÓ"} — congela builds/ejecuciones de verdad, no evadible por el app, falla-cerrado, suspende por-org, el dueño remedia con bitácora.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
