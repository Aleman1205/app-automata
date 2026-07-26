// ─────────────────────────────────────────────────────────────────────────────
// Verificación de los handlers de webhooks (docs/13 §4) contra Postgres, corriendo como el
// rol NO-SUPER `automata_webhook` (sujeto a FORCE RLS) — NO como superusuario, para que la
// regresión de "no-op silencioso bajo RLS" (hallazgo ALTA de la revisión) se cace de verdad.
// Los resolvers SECURITY DEFINER descubren la org cross-org; el handler fija app.current_org
// y reusa confirmarAjuste/fallarAjuste; Stripe tiene guard monótono anti out-of-order.
//   ADMIN_URL=... WEBHOOK_URL=... DATABASE_URL=... npm run verify:webhooks:handlers:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool } from "../src/db/pg.ts";
import { procesarCma, procesarStripe } from "../src/webhooks/handlers.ts";
import { type Evento } from "../src/webhooks/receptor.ts";
import { type Pool, type PoolClient } from "pg";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "postgres://automata_webhook@127.0.0.1:55432/postgres";
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
  const enTx = async (fn: (c: PoolClient) => Promise<void>) => {
    const c = await wh.connect();
    try { await c.query("BEGIN"); await fn(c); await c.query("COMMIT"); } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  };
  const seedVersion = async (sid: string, tipo: string, numero: number) => {
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado, tipo, cma_session_id, creada) VALUES ($1,$2,$3,'building',$4,$5, now() - interval '5 min')", [AUTO, A, numero, tipo, sid]);
  };
  const estadoVer = (sid: string) => admin.query<{ estado: string; ak: string | null; id: string }>("SELECT id, estado, artefacto_key AS ak FROM versiones WHERE cma_session_id=$1", [sid]).then((r) => r.rows[0]);
  const ajustes = () => admin.query<{ n: number }>("SELECT ajustes_usados AS n FROM automatizaciones WHERE id=$1", [AUTO]).then((r) => r.rows[0]?.n ?? -1);
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

    console.log("\n1. CMA ÉXITO (como rol no-super): building→lista + consume ajuste + clave:");
    const aj0 = await ajustes();
    await enTx((c) => procesarCma(c, evCma("session.completed", "sess_ok")));
    const vok = await estadoVer("sess_ok");
    check("la versión pasó a 'lista' (el handler NO fue no-op bajo RLS)", vok?.estado === "lista");
    check("consumió el ajuste", (await ajustes()) === aj0 + 1);
    check("fijó la clave determinista del artefacto", vok?.ak === `artefactos/${vok?.id}.json`);

    console.log("\n2. CMA FALLO: building→failed (libera el 'en vuelo'):");
    await seedVersion("sess_fail", "cambio", 2);
    await enTx((c) => procesarCma(c, evCma("session.failed", "sess_fail")));
    check("la versión pasó a 'failed'", (await estadoVer("sess_fail"))?.estado === "failed");

    console.log("\n3. Robustez CMA (no-op ante tipo/sesión desconocidos; alerta éxito-tras-reaper):");
    await seedVersion("sess_unk", "cambio", 3);
    await enTx((c) => procesarCma(c, evCma("session.log", "sess_unk")));
    check("tipo informativo → no-op (sigue 'building')", (await estadoVer("sess_unk"))?.estado === "building");
    await enTx((c) => procesarCma(c, evCma("session.completed", "sess_inexistente")));
    check("sesión desconocida → no-op (no lanza)", true);
    await admin.query("UPDATE versiones SET estado='failed' WHERE cma_session_id='sess_unk'"); // reaper la mató
    await enTx((c) => procesarCma(c, evCma("session.completed", "sess_unk"))); // éxito tras reaper → alerta+no-op
    check("éxito tras reaper: no revive la versión (sigue 'failed')", (await estadoVer("sess_unk"))?.estado === "failed");

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
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = $1", [A]).catch(() => {});
    await admin.end(); await wh.end(); await app.end();
  }

  console.log(`\n${ok ? "✓ HANDLERS DE WEBHOOKS PROBADOS" : "✗ FALLÓ"} — corren bajo RLS como rol no-super (resolvers SD + app.current_org), CMA cierra el ciclo, Stripe transiciona con guard monótono.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
