// ─────────────────────────────────────────────────────────────────────────────
// Verificación de los handlers de webhooks (docs/13 §4) contra Postgres, corriendo como el
// rol NO-SUPER `automata_webhook` (sujeto a FORCE RLS) — NO como superusuario, para que la
// regresión de "no-op silencioso bajo RLS" (hallazgo ALTA de la revisión) se cace de verdad.
// Los resolvers SECURITY DEFINER descubren la org cross-org; el handler fija app.current_org
// y reusa confirmarAjuste/fallarAjuste; Stripe tiene guard monótono anti out-of-order.
//   ADMIN_URL=... WEBHOOK_URL=... DATABASE_URL=... npm run verify:webhooks:handlers:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool } from "../src/db/pg.ts";
import { procesarCma, procesarStripe, type CambioPlan } from "../src/webhooks/handlers.ts";
import { type Evento } from "../src/webhooks/receptor.ts";
import { type Pool, type PoolClient } from "pg";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
// Acepta los DOS nombres: `DATABASE_URL_WEBHOOK` es el que usa la app (web/.env) y el resto de la
// suite; `WEBHOOK_URL` es el que tenía solo este script. Con nombres distintos para lo mismo,
// apuntar la suite a otro cluster dejaba ESTE pool en el de siempre y el test fallaba mezclando
// dos bases — un falso positivo que parece bug del producto.
const WEBHOOK_URL = process.env.DATABASE_URL_WEBHOOK ?? process.env.WEBHOOK_URL ?? "postgres://automata_webhook@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AUTO = "e3000000-0000-0000-0000-00000000000a";

let admin: Pool, wh: Pool;
let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const evCma = (tipo: string, sessionId: string): Evento => ({ id: `wh_${sessionId}_${tipo}`, tipo, recurso: { fuente: "cma", sessionId } });
const evStripe = (tipo: string, customerId: string, ts: number): Evento => ({ id: `evt_${tipo}_${ts}`, tipo, recurso: { fuente: "stripe", customerId }, ts });

async function main() {
  admin = crearPool(ADMIN_URL);
  wh = crearPool(WEBHOOK_URL);
  const app = crearPool(APP_URL);
  // Corre `procesar` en una tx del pool de WEBHOOK (rol no-super, como el receptor real).
  const enTx = async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await wh.connect();
    try { await c.query("BEGIN"); await fn(c); await c.query("COMMIT"); } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  };
  const seedVersion = async (sid: string, tipo: string, numero: number) => {
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado, tipo, cma_session_id, creada) VALUES ($1,$2,$3,'building',$4,$5, now() - interval '5 min')", [AUTO, A, numero, tipo, sid]);
  };
  const estadoVer = (sid: string) => admin.query<{ estado: string; ak: string | null; id: string }>("SELECT id, estado, artefacto_key AS ak FROM versiones WHERE cma_session_id=$1", [sid]).then((r) => r.rows[0]);
  const estadoSub = () => admin.query<{ e: string }>("SELECT estado AS e FROM subscriptions WHERE org_id=$1", [A]).then((r) => r.rows[0]?.e);

  try {
    await admin.query("DELETE FROM orgs WHERE id = $1", [A]);
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [A]);
    await admin.query("INSERT INTO subscriptions (org_id,plan,stripe_customer_id) VALUES ($1,'equipo','cus_123')", [A]);
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'a')", [AUTO, A]);
    await admin.query("UPDATE automatizaciones SET entregada = now() - interval '90 days' WHERE id=$1", [AUTO]);

    console.log("0. La regresión que la revisión cazó: el rol no-super NO lee cross-org, pero el resolver SÍ:");
    await seedVersion("sess_ok", "cambio", 1);
    const directo = await wh.query("SELECT id FROM versiones WHERE cma_session_id='sess_ok'").then((r) => r.rowCount ?? 0);
    check("SELECT directo de versiones como automata_webhook (sin contexto) → 0 filas (RLS)", directo === 0);
    const viaResolver = await wh.query("SELECT version_id FROM resolver_sesion_cma('sess_ok')").then((r) => r.rowCount ?? 0);
    check("resolver_sesion_cma (SECURITY DEFINER) SÍ resuelve cross-org → 1 fila", viaResolver === 1);
    check("automata_app NO puede llamar el resolver (revocado) → 42501", await app.query("SELECT resolver_sesion_cma('x')").then(() => false).catch((e) => (e as { code?: string }).code === "42501"));

    const enOutbox = (sid: string) => admin.query<{ n: number }>("SELECT count(*)::int AS n FROM cosecha_pendiente WHERE session_id=$1", [sid]).then((r) => r.rows[0]?.n ?? 0);
    // Contar filas NO basta: version_id y auto_id son los dos uuid, así que cruzarlos inserta
    // igual de bien y el conteo sigue dando 1. Ese fue el hallazgo CRÍTICO de la auditoría por
    // mutación (AUDITORIA-SUITE.md, Parte 2): con los ids cruzados el drainer no encuentra la
    // versión, reporta 'cosechado', borra el outbox, y la versión real se queda 'building' hasta
    // que el reaper la mata a las 6 h. Le pasa a TODOS los builds: cada cliente paga ~$1.8 y no
    // recibe nada mientras el cron informa cosechados>0. Hay que mirar QUÉ se encoló.
    const filaOutbox = (sid: string) =>
      admin.query<{ version_id: string; auto_id: string; org_id: string }>(
        "SELECT version_id, auto_id, org_id FROM cosecha_pendiente WHERE session_id=$1", [sid],
      ).then((r) => r.rows[0]);

    console.log("\n1. CMA status_idled (tipo REAL): ENCOLA en el outbox, NO confirma in-tx:");
    await enTx((c) => procesarCma(c, evCma("session.status_idled", "sess_ok")));
    check("la versión sigue 'building' (la cosecha la hace el drainer, no el webhook)", (await estadoVer("sess_ok"))?.estado === "building");
    check("encoló en cosecha_pendiente (idempotente por session_id)", (await enOutbox("sess_ok")) === 1);
    const fila = await filaOutbox("sess_ok");
    const verOk = await estadoVer("sess_ok");
    check("encoló la VERSIÓN correcta (no otro uuid: cruzarlos inserta igual y el drainer no la encuentra)", fila?.version_id === verOk?.id);
    check("encoló la AUTOMATIZACIÓN correcta", fila?.auto_id === AUTO);
    check("encoló la ORG del resolver FIRMADO (no una del payload)", fila?.org_id === A);
    await enTx((c) => procesarCma(c, evCma("session.status_idled", "sess_ok"))); // duplicado
    check("un status_idled duplicado NO crea segunda fila (ON CONFLICT)", (await enOutbox("sess_ok")) === 1);

    console.log("\n2. CMA status_terminated (tipo REAL): building→failed in-tx (libera el 'en vuelo'):");
    await seedVersion("sess_fail", "cambio", 2);
    await enTx((c) => procesarCma(c, evCma("session.status_terminated", "sess_fail")));
    check("la versión pasó a 'failed'", (await estadoVer("sess_fail"))?.estado === "failed");
    check("un fallo NO encola cosecha", (await enOutbox("sess_fail")) === 0);

    console.log("\n3. Robustez CMA (informativo/desconocido/sesión desconocida; alerta idle-tras-reaper):");
    await seedVersion("sess_unk", "cambio", 3);
    await enTx((c) => procesarCma(c, evCma("session.outcome_evaluation_ended", "sess_unk")));
    check("tipo informativo → no-op (sigue 'building', sin outbox)", (await estadoVer("sess_unk"))?.estado === "building" && (await enOutbox("sess_unk")) === 0);
    await enTx((c) => procesarCma(c, evCma("session.frobnicate", "sess_unk"))); // tipo inventado
    check("tipo NO reconocido → no-op + incidente (sigue 'building')", (await estadoVer("sess_unk"))?.estado === "building");
    check("...y dejó un incidente 'webhook_desconocido'", (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM incidentes WHERE tipo='webhook_desconocido'")).rows[0]!.n >= 1);
    await enTx((c) => procesarCma(c, evCma("session.status_idled", "sess_inexistente")));
    check("sesión desconocida → no-op (no lanza)", true);
    await admin.query("UPDATE versiones SET estado='failed' WHERE cma_session_id='sess_unk'"); // reaper la mató
    await enTx((c) => procesarCma(c, evCma("session.status_idled", "sess_unk"))); // idle tras reaper → alerta+no-op
    check("idle tras reaper: no revive la versión (sigue 'failed'), no encola", (await estadoVer("sess_unk"))?.estado === "failed" && (await enOutbox("sess_unk")) === 0);

    console.log("\n4. Stripe (como rol no-super): estado de la suscripción con guard MONÓTONO:");
    await enTx((c) => procesarStripe(c, evStripe("invoice.payment_failed", "cus_123", 100)));
    check("payment_failed(ts=100) → morosa (el UPDATE NO fue no-op bajo RLS)", (await estadoSub()) === "morosa");
    await enTx((c) => procesarStripe(c, evStripe("invoice.payment_succeeded", "cus_123", 200)));
    check("payment_succeeded(ts=200) → activa", (await estadoSub()) === "activa");
    await enTx((c) => procesarStripe(c, evStripe("invoice.payment_failed", "cus_123", 150))); // VIEJO, fuera de orden
    check("payment_failed VIEJO(ts=150) NO regresa a morosa (guard monótono)", (await estadoSub()) === "activa");
    await enTx((c) => procesarStripe(c, evStripe("customer.subscription.deleted", "cus_123", 300)));
    check("subscription.deleted(ts=300) → cancelada", (await estadoSub()) === "cancelada");
    await enTx((c) => procesarStripe(c, evStripe("customer.subscription.updated", "cus_123", 400)));
    check("evento de plan (no accionable) → no toca el estado", (await estadoSub()) === "cancelada");
    await enTx((c) => procesarStripe(c, evStripe("invoice.payment_failed", "cus_desconocido", 500)));
    check("customer no mapeado → no-op (no lanza)", true);

    console.log("\n4bis. El CAMBIO DE PLAN que devuelve el handler (el wiring lo aplica tras el commit):");
    // Sección nueva (auditoría por mutación, Parte 2): la suite ejercitaba `procesarStripe` pero
    // JAMÁS miraba su valor de retorno, que es donde viaja el cambio de plan. Con eso, hacer que un
    // price desconocido devolviera `{plan:'base'}` pasaba en verde — y ese es un DOWNGRADE real:
    // Stripe manda `checkout.session.completed` SIN price junto al `subscription.created` que sí lo
    // trae, así que un cliente que acaba de pagar Equipo ($1,999) caería a 3 espacios y sus
    // automatizaciones excedentes a solo-lectura. Nadie lo detectaría: el fallo del webhook es
    // best-effort y ni siquiera se le reporta a Stripe.
    process.env.STRIPE_PRICE_EQUIPO = "price_equipo_test";
    const enTxR = async (fn: (c: PoolClient) => Promise<CambioPlan | undefined>) => {
      const c = await wh.connect();
      try { await c.query("BEGIN"); const v = await fn(c); await c.query("COMMIT"); return v; }
      catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
    };
    const evPrecio = (tipo: string, priceId?: string, orgRef?: string): Evento =>
      ({ id: `evt_${tipo}_${priceId ?? "sin"}`, tipo, recurso: { fuente: "stripe", customerId: "cus_123", priceId, orgRef }, ts: 600 });

    // Control POSITIVO: sin él, una mutación que devolviera siempre `undefined` (nunca cambiar de
    // plan: el cliente paga Equipo y se queda en Base) pasaría los dos checks negativos de abajo.
    const conocido = await enTxR((c) => procesarStripe(c, evPrecio("customer.subscription.updated", "price_equipo_test")));
    check("price CONOCIDO → devuelve el plan que se pagó", conocido?.plan === "equipo" && conocido?.org === A);

    const desconocido = await enTxR((c) => procesarStripe(c, evPrecio("customer.subscription.updated", "price_que_nadie_dio_de_alta")));
    check("price DESCONOCIDO → sin cambio de plan (nunca se adivina)", desconocido === undefined);

    const sinPrice = await enTxR((c) => procesarStripe(c, evPrecio("checkout.session.completed", undefined, A)));
    check("checkout SIN price → sin cambio (si devolviera 'base', degradaría a quien acaba de pagar)", sinPrice === undefined);
  } finally {
    await admin.query("DELETE FROM cosecha_pendiente WHERE org_id = $1", [A]).catch(() => {}); // outbox: sin FK a orgs
    await admin.query("DELETE FROM incidentes WHERE org_id = $1 OR org_id IS NULL", [A]).catch(() => {});
    await admin.query("DELETE FROM orgs WHERE id = $1", [A]).catch(() => {});
    await admin.end(); await wh.end(); await app.end();
  }

  console.log(`\n${ok ? "✓ HANDLERS DE WEBHOOKS PROBADOS" : "✗ FALLÓ"} — corren bajo RLS como rol no-super (resolvers SD + app.current_org), CMA cierra el ciclo, Stripe transiciona con guard monótono.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
