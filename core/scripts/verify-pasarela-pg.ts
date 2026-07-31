// ─────────────────────────────────────────────────────────────────────────────
// Verificación del CHECKOUT y el PORTAL de Stripe contra Postgres, con la pasarela FALSA (sin
// llaves, sin red). Lo que se prueba es lo que puede costar dinero o dejar a alguien sin poder
// pagar; la llamada al SDK de Stripe en sí NO se prueba aquí (vive en el wiring de web/).
//   1. el checkout manda el orgId como client_reference_id — es lo ÚNICO con que el webhook vincula
//   2. reusa el customer si la org ya pagó (si no, app_stripe_vincular write-once rechaza el 2º)
//   3. un precio mal configurado NO cobra a ciegas (falta, o mapea a otro plan)
//   4. el portal exige suscripción existente
//   5. RLS: cada org ve su propio customer, nunca el de otra
//   ADMIN_URL=... DATABASE_URL=... npm run verify:pasarela:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import {
  iniciarCheckout, abrirPortalCliente, precioDePlan, esPlanPagable,
  PagosNoConfigurados, SinSuscripcion, YaTieneSuscripcion, type Pasarela,
} from "../src/billing/pasarela.ts";
import { ServicioSuspendido } from "../src/ops/killswitch.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "0aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab01";
const B = "0aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaab02";
const ORIGEN = "https://app.ejemplo.mx";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

// Captura lo que se le pediría a Stripe: es la prueba de que el checkout lleva los campos que el
// webhook YA existente necesita para procesarlo.
class FakePasarela implements Pasarela {
  checkout?: { orgId: string; priceId: string; clienteId?: string; exitoUrl: string; cancelUrl: string };
  portal?: { clienteId: string; volverUrl: string };
  async crearCheckout(a: NonNullable<FakePasarela["checkout"]>) { this.checkout = a; return "https://checkout.stripe.com/c/sesion_falsa"; }
  async abrirPortal(a: NonNullable<FakePasarela["portal"]>) { this.portal = a; return "https://billing.stripe.com/p/sesion_falsa"; }
}

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const pasarela = new FakePasarela();
  const envPrevias = { b: process.env.STRIPE_PRICE_BASE, p: process.env.STRIPE_PRICE_PRO, e: process.env.STRIPE_PRICE_EQUIPO };
  process.env.STRIPE_PRICE_BASE = "price_base_test";
  process.env.STRIPE_PRICE_PRO = "price_pro_test";
  process.env.STRIPE_PRICE_EQUIPO = "price_equipo_test";

  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]);
    for (const [id, nom] of [[A, "Paga"], [B, "Otra"]] as const) {
      await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,$2)", [id, nom]);
      // 'pendiente' = como nace una org real (app_provisionar_usuario la crea así: no gasta nada
      // hasta que paga). El DEFAULT de la columna sigue siendo 'activa' por compatibilidad, así que
      // hay que ser explícito o el test arrancaría desde un estado que ningún cliente nuevo tiene.
      await admin.query("INSERT INTO subscriptions (org_id,plan,estado) VALUES ($1,'base','pendiente')", [id]);
    }

    console.log("1. El checkout lleva lo que el webhook necesita para vincular el pago:");
    const r1 = await conOrg(app, A, (c) => iniciarCheckout(c, pasarela, { orgId: A, plan: "pro", origen: ORIGEN }));
    check("devuelve una URL de Stripe", r1.url.startsWith("https://checkout.stripe.com/"));
    // Sin client_reference_id el webhook NO puede saber qué org pagó: hace `return` sin vincular y
    // el cobro entra sin que el producto se entere de nada.
    check("manda el orgId (viaja como client_reference_id)", pasarela.checkout?.orgId === A);
    check("manda el price del plan pedido, no otro", pasarela.checkout?.priceId === "price_pro_test");
    check("vuelve a /cuenta al terminar y al cancelar",
      pasarela.checkout?.exitoUrl === `${ORIGEN}/cuenta?pago=listo` && pasarela.checkout?.cancelUrl === `${ORIGEN}/cuenta?pago=cancelado`);
    check("sin suscripción previa NO manda customer (Stripe crea uno)", pasarela.checkout?.clienteId === undefined);

    console.log("\n2. Con suscripción VIVA el checkout se niega (si no, serían DOS cargos al mes):");
    // El bug caro: Stripe Checkout en mode:'subscription' NO cambia la suscripción existente, CREA
    // OTRA sobre el mismo customer. El cliente picaba "cambiar de plan" y acababa con dos cobros
    // mensuales, y el webhook —que solo ve el price del último evento— le ponía el plan nuevo sin
    // enterarse. Los cambios de plan van por el PORTAL, que es donde Stripe prorratea.
    await admin.query("UPDATE subscriptions SET estado='activa', stripe_customer_id='cus_de_A' WHERE org_id=$1", [A]);
    check("suscripción activa → YaTieneSuscripcion (no una segunda sesión de pago)",
      await conOrg(app, A, (c) => iniciarCheckout(c, pasarela, { orgId: A, plan: "equipo", origen: ORIGEN }))
        .then(() => false).catch((e) => e instanceof YaTieneSuscripcion));
    // 'morosa' es una suscripción que EXISTE y cuyo cobro falló: mandarla al checkout crearía una
    // segunda en vez de arreglar la tarjeta de la primera.
    await admin.query("UPDATE subscriptions SET estado='morosa' WHERE org_id=$1", [A]);
    check("morosa también se niega (la suscripción existe; lo que falló fue el cobro)",
      await conOrg(app, A, (c) => iniciarCheckout(c, pasarela, { orgId: A, plan: "equipo", origen: ORIGEN }))
        .then(() => false).catch((e) => e instanceof YaTieneSuscripcion));

    console.log("\n2bis. Quien CANCELÓ sí puede volver, reusando su customer:");
    await admin.query("UPDATE subscriptions SET estado='cancelada' WHERE org_id=$1", [A]);
    await conOrg(app, A, (c) => iniciarCheckout(c, pasarela, { orgId: A, plan: "equipo", origen: ORIGEN }));
    // Sin reusar el customer se crearía uno nuevo y app_stripe_vincular (write-once) rechazaría el
    // segundo: el cliente pagaría y el producto seguiría atado al customer viejo.
    check("reusa el customer existente en vez de crear otro", pasarela.checkout?.clienteId === "cus_de_A");
    check("y usa el price del plan NUEVO", pasarela.checkout?.priceId === "price_equipo_test");
    await admin.query("UPDATE subscriptions SET estado='pendiente' WHERE org_id=$1", [A]);

    console.log("\n3. Un precio mal configurado NO cobra a ciegas:");
    delete process.env.STRIPE_PRICE_PRO;
    check("price faltante → PagosNoConfigurados (no una sesión sin precio)",
      await conOrg(app, A, (c) => iniciarCheckout(c, pasarela, { orgId: A, plan: "pro", origen: ORIGEN }))
        .then(() => false).catch((e) => e instanceof PagosNoConfigurados));
    // El caso caro y silencioso: dos planes con el MISMO price. Se cobraría uno y se entregaría el
    // otro, y el webhook (que solo ve el price) tendría razón al entregar el que no es.
    // OJO con cómo se prueba: `planDePrecio` construye un objeto literal, así que con la llave
    // repetida gana el ÚLTIMO y responde sin quejarse — preguntarle a él NO caza esto (el primer
    // intento de este test pasaba en verde con el bug presente). Hay que contar los dueños del price.
    process.env.STRIPE_PRICE_PRO = "price_base_test";
    check("dos planes con el MISMO price → se rechaza (cobrar Pro y entregar Base)",
      await conOrg(app, A, (c) => iniciarCheckout(c, pasarela, { orgId: A, plan: "pro", origen: ORIGEN }))
        .then(() => false).catch((e) => e instanceof PagosNoConfigurados));
    check("y también al revés (pedir Base con el price duplicado)",
      await conOrg(app, A, (c) => iniciarCheckout(c, pasarela, { orgId: A, plan: "base", origen: ORIGEN }))
        .then(() => false).catch((e) => e instanceof PagosNoConfigurados));
    process.env.STRIPE_PRICE_PRO = "price_pro_test";
    check("planes válidos son solo base/pro/equipo", esPlanPagable("pro") && !esPlanPagable("gratis") && !esPlanPagable(""));
    check("precioDePlan ignora una env vacía (no manda priceId='')", (() => {
      process.env.STRIPE_PRICE_BASE = "   ";
      const v = precioDePlan("base");
      process.env.STRIPE_PRICE_BASE = "price_base_test";
      return v === undefined;
    })());

    console.log("\n4. El portal de cliente exige una suscripción que exista:");
    const r4 = await conOrg(app, A, (c) => abrirPortalCliente(c, pasarela, { origen: ORIGEN }));
    check("con customer → abre el portal de esa org", r4.url.startsWith("https://billing.stripe.com/") && pasarela.portal?.clienteId === "cus_de_A");
    check("y vuelve a /cuenta", pasarela.portal?.volverUrl === `${ORIGEN}/cuenta`);
    check("sin customer (nunca pagó) → SinSuscripcion, no un portal vacío",
      await conOrg(app, B, (c) => abrirPortalCliente(c, pasarela, { origen: ORIGEN }))
        .then(() => false).catch((e) => e instanceof SinSuscripcion));

    console.log("\n5. Aislamiento: nadie abre el portal de otra org:");
    // El customer se lee bajo RLS, sin filtro por org en el SQL: si RLS fallara, B abriría la
    // facturación de A (tarjeta, facturas, cancelar). Es la peor fuga posible de esta pieza.
    await admin.query("UPDATE subscriptions SET stripe_customer_id='cus_de_B' WHERE org_id=$1", [B]);
    await conOrg(app, B, (c) => abrirPortalCliente(c, pasarela, { origen: ORIGEN }));
    check("B abre el SUYO, no el de A", pasarela.portal?.clienteId === "cus_de_B");
    await conOrg(app, A, (c) => abrirPortalCliente(c, pasarela, { origen: ORIGEN }));
    check("A abre el suyo", pasarela.portal?.clienteId === "cus_de_A");

    console.log("\n6. Kill-switch de cobros: frena el checkout, NO el portal:");
    await admin.query("UPDATE interruptores SET cobros = true");
    check("con los cobros frenados el checkout se niega (no se acepta dinero sin poder conciliarlo)",
      await conOrg(app, A, (c) => iniciarCheckout(c, pasarela, { orgId: A, plan: "pro", origen: ORIGEN }))
        .then(() => false).catch((e) => e instanceof ServicioSuspendido));
    // Deliberado: el portal es la ÚNICA puerta por la que un moroso arregla su tarjeta o cancela.
    // Cerrarlo durante un incidente de facturación deja atrapada a la gente que quiere ponerse al
    // corriente — o dejar de pagar, que también es su derecho.
    check("pero el portal SIGUE abierto (si no, nadie podría arreglar su tarjeta ni cancelar)",
      await conOrg(app, A, (c) => abrirPortalCliente(c, pasarela, { origen: ORIGEN })).then((r) => r.url.length > 0).catch(() => false));
    await admin.query("UPDATE interruptores SET cobros = false");
  } finally {
    process.env.STRIPE_PRICE_BASE = envPrevias.b; process.env.STRIPE_PRICE_PRO = envPrevias.p; process.env.STRIPE_PRICE_EQUIPO = envPrevias.e;
    if (envPrevias.b === undefined) delete process.env.STRIPE_PRICE_BASE;
    if (envPrevias.p === undefined) delete process.env.STRIPE_PRICE_PRO;
    if (envPrevias.e === undefined) delete process.env.STRIPE_PRICE_EQUIPO;
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ PASARELA PROBADA" : "✗ FALLÓ"} — checkout con client_reference_id y customer reusado, precio mal configurado rechazado, portal solo con suscripción y acotado por org. (La llamada real al SDK de Stripe vive en el wiring y NO se prueba aquí.)`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
