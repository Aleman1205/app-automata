// ─────────────────────────────────────────────────────────────────────────────
// Verificación de los handlers de webhooks (docs/13 §4) contra Postgres: el fin-de-build
// de CMA cierra el ciclo (ÉXITO → building→lista + consume ajuste; FALLO → failed, libera
// el "en vuelo" SIN esperar el reaper) mapeando sesión FIRMADA → versión por lookup en
// NUESTRA DB; y el webhook de Stripe transiciona el estado de la suscripción. Los handlers
// corren como DUEÑO (el receptor los llama así); aquí se ejercen con un cliente de dueño.
//   ADMIN_URL=... npm run verify:webhooks:handlers:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool } from "../src/db/pg.ts";
import { procesarCma, procesarStripe } from "../src/webhooks/handlers.ts";
import { type Evento } from "../src/webhooks/receptor.ts";
import { type PoolClient } from "pg";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AUTO = "e3000000-0000-0000-0000-00000000000a";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const evCma = (tipo: string, sessionId: string): Evento => ({ id: `wh_${sessionId}`, tipo, recurso: { fuente: "cma", sessionId } });
const evStripe = (tipo: string, customerId: string): Evento => ({ id: `evt_${tipo}`, tipo, recurso: { fuente: "stripe", customerId } });

async function main() {
  const admin = crearPool(ADMIN_URL);
  // Corre procesar dentro de una tx (como el receptor). Cada llamada su propia tx.
  const enTx = async (fn: (c: PoolClient) => Promise<void>) => {
    const c = await admin.connect();
    try { await c.query("BEGIN"); await fn(c); await c.query("COMMIT"); } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  };
  const seedVersion = async (sid: string, tipo: string, numero: number) => {
    await admin.query(
      "INSERT INTO versiones (automatizacion_id, org_id, numero, estado, tipo, cma_session_id, creada) VALUES ($1,$2,$3,'building',$4,$5, now() - interval '5 min')",
      [AUTO, A, numero, tipo, sid],
    );
  };
  const estadoVer = (sid: string) => admin.query<{ estado: string; ak: string | null }>("SELECT estado, artefacto_key AS ak FROM versiones WHERE cma_session_id=$1", [sid]).then((r) => r.rows[0]);
  const ajustes = () => admin.query<{ n: number }>("SELECT ajustes_usados AS n FROM automatizaciones WHERE id=$1", [AUTO]).then((r) => r.rows[0]?.n ?? -1);

  try {
    await admin.query("DELETE FROM orgs WHERE id = $1", [A]);
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [A]);
    await admin.query("INSERT INTO subscriptions (org_id,plan,stripe_customer_id) VALUES ($1,'equipo','cus_123')", [A]);
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'a')", [AUTO, A]);
    await admin.query("UPDATE automatizaciones SET entregada = now() - interval '90 days' WHERE id=$1", [AUTO]); // fuera de ventana → cambio consume

    console.log("1. CMA fin-de-build → ÉXITO: building→lista + consume ajuste + clave de artefacto:");
    await seedVersion("sess_ok", "cambio", 1);
    const aj0 = await ajustes();
    await enTx((c) => procesarCma(c, evCma("session.completed", "sess_ok")));
    const vok = await estadoVer("sess_ok");
    check("la versión pasó a 'lista'", vok?.estado === "lista");
    check("consumió el ajuste (cambio, fuera de ventana)", (await ajustes()) === aj0 + 1);
    check("fijó la clave determinista del artefacto", vok?.ak === `artefactos/${(await admin.query<{ id: string }>("SELECT id FROM versiones WHERE cma_session_id='sess_ok'", [])).rows[0]?.id}.json`);

    console.log("\n2. CMA fin-de-build → FALLO: building→failed (libera el 'en vuelo', sin esperar reaper):");
    await seedVersion("sess_fail", "cambio", 2);
    await enTx((c) => procesarCma(c, evCma("session.failed", "sess_fail")));
    check("la versión pasó a 'failed'", (await estadoVer("sess_fail"))?.estado === "failed");

    console.log("\n3. Robustez del handler de CMA:");
    await seedVersion("sess_unk", "cambio", 3);
    await enTx((c) => procesarCma(c, evCma("session.log", "sess_unk"))); // tipo NO accionable
    check("un tipo desconocido → no-op (la versión sigue 'building')", (await estadoVer("sess_unk"))?.estado === "building");
    await enTx((c) => procesarCma(c, evCma("session.completed", "sess_inexistente"))); // sesión desconocida
    check("una sesión desconocida → no-op (no lanza)", true);

    console.log("\n4. Stripe → estado de la suscripción (deriva la org por stripe_customer_id):");
    const estadoSub = () => admin.query<{ e: string }>("SELECT estado AS e FROM subscriptions WHERE org_id=$1", [A]).then((r) => r.rows[0]?.e);
    await enTx((c) => procesarStripe(c, evStripe("invoice.payment_failed", "cus_123")));
    check("payment_failed → morosa", (await estadoSub()) === "morosa");
    await enTx((c) => procesarStripe(c, evStripe("invoice.payment_succeeded", "cus_123")));
    check("payment_succeeded → activa", (await estadoSub()) === "activa");
    await enTx((c) => procesarStripe(c, evStripe("customer.subscription.deleted", "cus_123")));
    check("subscription.deleted → cancelada", (await estadoSub()) === "cancelada");
    await admin.query("UPDATE subscriptions SET estado='activa' WHERE org_id=$1", [A]);
    await enTx((c) => procesarStripe(c, evStripe("customer.subscription.updated", "cus_123"))); // no accionable (necesita SDK)
    check("evento de plan (no accionable) → no toca el estado", (await estadoSub()) === "activa");
    await enTx((c) => procesarStripe(c, evStripe("invoice.payment_failed", "cus_desconocido"))); // customer no mapeado
    check("customer no mapeado → no-op (no lanza, 0 filas)", true);
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = $1", [A]).catch(() => {});
    await admin.end();
  }

  console.log(`\n${ok ? "✓ HANDLERS DE WEBHOOKS PROBADOS" : "✗ FALLÓ"} — CMA cierra el ciclo (éxito/fallo) por lookup de sesión; Stripe transiciona el estado; org derivada del recurso firmado.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
