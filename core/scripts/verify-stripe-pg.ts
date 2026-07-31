// ─────────────────────────────────────────────────────────────────────────────
// Verificación del camino de STRIPE contra Postgres, con payloads FALSOS (sin llaves ni red).
// Cubre el eslabón que faltaba: stripe_customer_id sólo lo escribía un script de prueba, así que
// resolver_org_stripe siempre devolvía NULL y TODO evento de Stripe salía por el no-op silencioso —
// Stripe cobraba y el producto no se enteraba. Prueba: (1) la SD vincula write-once y NO deja robar
// el customer de otra org; (2) el plan lo dicta el PRICE del evento (mapa desde las envs); (3)
// checkout.session.completed vincula + fija el plan; (4) un upgrade aplica de inmediato; (5) un
// downgrade deja el EXCEDENTE en solo lectura (reusa aplicarDowngrade); (6) un price desconocido no
// toca el plan (nunca se adivina).
//   ADMIN_URL=... DATABASE_URL=... npm run verify:stripe:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool } from "../src/db/pg.ts";
import { procesarStripe, planDePrecio } from "../src/webhooks/handlers.ts";
import { aplicarDowngrade } from "../src/billing/plan.ts";
import { extraerEvento, type Evento } from "../src/webhooks/receptor.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
// Conecta CON el rol de webhooks, como en produccion (DATABASE_URL_WEBHOOK). No se usa SET ROLE:
// automata_app no es miembro de automata_webhook — y eso esta bien, es aislamiento de privilegios.
const WEBHOOK_URL = process.env.DATABASE_URL_WEBHOOK ?? "postgres://automata_webhook@127.0.0.1:55432/postgres";
const A = "0bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"; // la org que paga
const B = "0bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2"; // otra org (intento de robo de customer)
const CUST = "cus_prueba_automata";

// IDs de price falsos: el mapeo los lee del entorno, así que cuando existan los reales solo se
// pegan las envs y este mismo código funciona sin cambios.
process.env.STRIPE_PRICE_BASE = "price_fake_base";
process.env.STRIPE_PRICE_PRO = "price_fake_pro";
process.env.STRIPE_PRICE_EQUIPO = "price_fake_equipo";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

const evento = (tipo: string, extra: Partial<Extract<Evento["recurso"], { fuente: "stripe" }>> = {}, ts = 1000): Evento => ({
  id: `evt_${tipo}_${ts}`,
  tipo,
  ts,
  recurso: { fuente: "stripe", customerId: CUST, ...extra },
});

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(WEBHOOK_URL);
  const uno = (sql: string, p: unknown[] = []) => admin.query<Record<string, unknown>>(sql, p).then((r) => r.rows[0]);
  const planDe = async (org: string) => (await uno("SELECT plan FROM subscriptions WHERE org_id=$1", [org]))?.["plan"];
  const activas = async (org: string) => (await uno("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id=$1 AND activa", [org]))?.["n"];
  // El handler corre con el rol de WEBHOOK (privilegios mínimos), como en producción.
  const conWebhook = async <T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  };

  // Como en produccion: el handler corre DENTRO de la tx del webhook y devuelve el cambio
  // pendiente; el plan se aplica DESPUES del commit, con el pool dueno. Hacerlo dentro deadlockeaba
  // (la conexion duena esperaba el lock de subscriptions que la tx del webhook aun tenia).
  const procesar = async (e: Evento) => {
    const pendiente = await conWebhook((c) => procesarStripe(c, e));
    if (pendiente) await aplicarDowngrade(admin, pendiente.org, pendiente.plan);
    return pendiente;
  };

  try {
    for (const id of [A, B]) {
      await admin.query("DELETE FROM orgs WHERE id=$1", [id]);
      await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'Stripe')", [id]);
      await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'base')", [id]);
    }

    console.log("1. El mapeo price → plan sale de las envs:");
    check("price de equipo → 'equipo'", planDePrecio("price_fake_equipo") === "equipo");
    check("price desconocido → undefined (no se adivina)", planDePrecio("price_de_otro_producto") === undefined);
    check("sin price → undefined", planDePrecio(undefined) === undefined);

    console.log("\n2. checkout.session.completed VINCULA el customer y fija el plan:");
    check("antes, resolver_org_stripe no encuentra nada (el bug que había)",
      (await uno("SELECT resolver_org_stripe($1) AS o", [CUST]))?.["o"] === null);
    await procesar(evento("checkout.session.completed", { orgRef: A, priceId: "price_fake_equipo" }));
    check("quedó vinculado a la org que pagó", (await uno("SELECT resolver_org_stripe($1) AS o", [CUST]))?.["o"] === A);
    check("y le aplicó el plan del price (equipo)", (await planDe(A)) === "equipo");

    console.log("\n3. El customer NO se puede reasignar a otra org (toma de control):");
    let robo = "";
    try {
      await procesar(evento("checkout.session.completed", { orgRef: B, priceId: "price_fake_pro" }));
    } catch (e) { robo = (e as Error).message; }
    check(`falla con STRIPE_CUSTOMER_DE_OTRA_ORG (fue: ${robo.slice(0, 40)})`, /STRIPE_CUSTOMER_DE_OTRA_ORG/.test(robo));
    check("la otra org sigue en su plan", (await planDe(B)) === "base");
    check("el customer sigue siendo de la org original", (await uno("SELECT resolver_org_stripe($1) AS o", [CUST]))?.["o"] === A);

    // La OTRA dirección del guard, que no se probaba: la org ya tiene un customer y llega un
    // checkout con OTRO. `app_stripe_vincular` es write-once por eso, y una auditoría por mutación
    // lo destapó: quitando ese IF, este verify seguía en verde.
    // Qué pasaría: el stripe_customer_id de la org se re-apunta al customer nuevo y TODOS los
    // eventos del viejo (pagos, fallos, cancelaciones) pasan a ser no-op silenciosos —
    // resolver_org_stripe ya no los mapea. Es exactamente el bug que este proyecto ya sufrió
    // cuando stripe_customer_id no tenía escritor: Stripe cobrando y el producto sin enterarse.
    console.log("\n3bis. Y la org tampoco puede cambiar de customer (write-once):");
    const OTRO_CUST = "cus_prueba_segundo";
    let doble = "";
    try {
      await procesar(evento("checkout.session.completed", { orgRef: A, customerId: OTRO_CUST, priceId: "price_fake_pro" }));
    } catch (e) { doble = (e as Error).message; }
    check(`falla con STRIPE_ORG_YA_TIENE_CUSTOMER (fue: ${doble.slice(0, 40)})`, /STRIPE_ORG_YA_TIENE_CUSTOMER/.test(doble));
    check("la org sigue apuntando a su customer ORIGINAL", (await uno("SELECT stripe_customer_id AS c FROM subscriptions WHERE org_id=$1", [A]))?.["c"] === CUST);
    check("y el customer nuevo no quedó mapeado a nadie", (await uno("SELECT resolver_org_stripe($1) AS o", [OTRO_CUST]))?.["o"] === null);
    // Re-vincular el MISMO customer sigue siendo idempotente (un webhook duplicado no debe fallar).
    check("re-vincular el MISMO customer no falla (idempotente ante webhooks duplicados)",
      await procesar(evento("checkout.session.completed", { orgRef: A, priceId: "price_fake_pro" })).then(() => true).catch(() => false));

    console.log("\n4. Un upgrade aplica de inmediato (el cliente pagó para poder usarlo YA):");
    await admin.query("UPDATE subscriptions SET plan='base' WHERE org_id=$1", [A]);
    await procesar(evento("customer.subscription.updated", { priceId: "price_fake_equipo" }, 2000));
    check("subió a equipo sin esperar al fin del periodo", (await planDe(A)) === "equipo");

    console.log("\n5. Un downgrade deja el EXCEDENTE en solo lectura (no borra nada):");
    await admin.query("INSERT INTO automatizaciones (org_id,nombre,activa) SELECT $1,'a'||g,true FROM generate_series(1,5) g", [A]);
    check("arranca con 5 activas (equipo permite 10)", (await activas(A)) === 5);
    await procesar(evento("customer.subscription.updated", { priceId: "price_fake_base" }, 3000));
    check("bajó a base", (await planDe(A)) === "base");
    check("dejó solo 3 activas (el tope de base), sin borrar", (await activas(A)) === 3);
    check("las otras 2 siguen existiendo, inactivas",
      (await uno("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id=$1 AND NOT activa", [A]))?.["n"] === 2);

    console.log("\n6. Un price de OTRO producto no toca el plan (anti cross-contaminación):");
    await procesar(evento("customer.subscription.updated", { priceId: "price_de_otro_producto" }, 4000));
    check("el plan sigue igual", (await planDe(A)) === "base");

    console.log("\n7. El estado sigue funcionando (no se rompió lo que ya había):");
    await procesar(evento("invoice.payment_failed", {}, 5000));
    check("un pago fallido la pone morosa", (await uno("SELECT estado FROM subscriptions WHERE org_id=$1", [A]))?.["estado"] === "morosa");
    await procesar(evento("invoice.payment_succeeded", {}, 4500));
    check("un evento MÁS VIEJO no la revive (guard monótono intacto)",
      (await uno("SELECT estado FROM subscriptions WHERE org_id=$1", [A]))?.["estado"] === "morosa");

    // El hueco que dejo pasar el bug del price: este archivo FABRICABA el Evento con priceId ya
    // puesto, sin pasar por extraerEvento. Asi nadie noto que un objeto Subscription trae
    // items.data[0].price.id pero una Checkout Session NO (usa line_items, y el webhook ni lo trae).
    console.log(String.fromCharCode(10) + "8. El PAYLOAD CRUDO de Stripe (por extraerEvento, como en produccion):");
    const crudoSub = JSON.stringify({
      id: "evt_sub_created", type: "customer.subscription.created", created: 9000,
      data: { object: { id: "sub_1", customer: CUST, items: { data: [{ price: { id: "price_fake_pro" } }] } } },
    });
    const evSub = extraerEvento("stripe", JSON.parse(crudoSub));
    check("extrae el customer", evSub?.recurso.fuente === "stripe" && evSub.recurso.customerId === CUST);
    check("extrae el price de una Subscription (items.data[0].price.id)",
      evSub?.recurso.fuente === "stripe" && evSub.recurso.priceId === "price_fake_pro");
    await admin.query("UPDATE subscriptions SET plan=$2 WHERE org_id=$1", [A, "base"]);
    if (evSub) await procesar(evSub);
    check("y con eso el plan del cliente SI cambia (antes se quedaba en base)", (await planDe(A)) === "pro");

    const crudoSesion = JSON.stringify({
      id: "evt_checkout", type: "checkout.session.completed", created: 9100,
      data: { object: { id: "cs_1", customer: CUST, client_reference_id: A } },
    });
    const evSes = extraerEvento("stripe", JSON.parse(crudoSesion));
    check("la Checkout Session extrae la org de client_reference_id",
      evSes?.recurso.fuente === "stripe" && evSes.recurso.orgRef === A);
    check("y NO trae price (por eso el plan lo fija subscription.created, no el checkout)",
      evSes?.recurso.fuente === "stripe" && evSes.recurso.priceId === undefined);
  } finally {
    for (const id of [A, B]) await admin.query("DELETE FROM orgs WHERE id=$1", [id]).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ STRIPE PROBADO" : "✗ FALLÓ"} — el pago vincula el customer, el price dicta el plan, el upgrade aplica ya y el downgrade deja el excedente en solo lectura.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
