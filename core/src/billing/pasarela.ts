import { type PoolClient } from "pg";
import { planDePrecio } from "../webhooks/handlers.ts";
import { exigirCobrosActivos } from "../ops/killswitch.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pasarela de pagos (Stripe): CHECKOUT (contratar / cambiar de plan) y PORTAL DE CLIENTE
// (cambiar tarjeta, ver facturas, cancelar).
//
// Lo que este módulo NO hace, a propósito: cambiar el plan. Stripe es la fuente de verdad de lo que
// el cliente realmente paga (docs/06), y el webhook YA deriva el plan del `price` del evento. Si el
// checkout además tocara el plan, habría DOS escritores del mismo dato y el que se equivocara le
// daría al cliente un plan que no compró —o le quitaría el que sí—, que son los dos errores caros
// de aquí. El checkout solo abre la caja; el webhook aplica lo que Stripe confirme.
//
// El puerto se INYECTA (como storage/cosechador/notificador): así los verify prueban la lógica
// —validación de plan, price faltante, portal sin suscripción, cliente reusado— con un doble, sin
// llaves y sin tocar la red.
// ─────────────────────────────────────────────────────────────────────────────

export const PLANES_PAGABLES = ["base", "pro", "equipo"] as const;
export type PlanPagable = (typeof PLANES_PAGABLES)[number];

export const esPlanPagable = (p: unknown): p is PlanPagable =>
  typeof p === "string" && (PLANES_PAGABLES as readonly string[]).includes(p);

/** Falta configuración de cobro (envs `STRIPE_PRICE_*` / llave). NO es culpa del cliente: es un
 *  despliegue a medias. Se distingue para que la UI no le diga "algo salió mal" a alguien que
 *  intentó pagar — y para que en el log quede claro que hay que ir a poner una env. */
export class PagosNoConfigurados extends Error {
  constructor(public readonly detalle: string) { super(`pagos no configurados: ${detalle}`); }
}
/** El portal de cliente sirve para administrar una suscripción que YA existe. Si la org nunca pagó
 *  no hay `stripe_customer_id`, y abrirlo sería mandarla a una pantalla vacía de Stripe: lo que
 *  necesita es el checkout. */
export class SinSuscripcion extends Error {}
/** Ya hay una suscripción viva, así que el CHECKOUT es la puerta equivocada: Stripe Checkout en
 *  `mode: "subscription"` NO modifica la suscripción existente — crea OTRA sobre el mismo customer.
 *  El cliente que picara "cambiar de plan" acabaría con dos suscripciones y DOS CARGOS mensuales, y
 *  el webhook (que solo ve el price del último evento) le pondría el plan nuevo tan campante, sin
 *  enterarse de que paga doble. Los cambios de plan van por el PORTAL, que es donde Stripe sabe
 *  prorratear y de donde vuelve `customer.subscription.updated` → el flujo de plan que ya existe. */
export class YaTieneSuscripcion extends Error {}
/** La pasarela falló (red, credenciales, Stripe caído). Se envuelve para que un error crudo del SDK
 *  no suba como 500 genérico: quien intentó pagar necesita saber que NO se le cobró. */
export class PasarelaCaida extends Error {}

export interface Pasarela {
  /** Sesión de pago. Devuelve la URL a la que hay que mandar al cliente. */
  crearCheckout(a: {
    orgId: string; // viaja como client_reference_id: es lo ÚNICO con que el webhook vincula el pago
    priceId: string;
    clienteId?: string; // customer existente (si ya pagó antes): evita duplicarlo en Stripe
    exitoUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  /** Portal de cliente de Stripe para una suscripción existente. Devuelve la URL. */
  abrirPortal(a: { clienteId: string; volverUrl: string }): Promise<string>;
}

/** price ← plan. Inverso de `planDePrecio`, y vive pegado a él (mismas envs, leídas en cada llamada)
 *  para que no puedan divergir: si alguien renombra una env y solo arregla un lado, el cliente
 *  compra un plan y recibe otro. */
export function precioDePlan(plan: PlanPagable): string | undefined {
  const env = { base: "STRIPE_PRICE_BASE", pro: "STRIPE_PRICE_PRO", equipo: "STRIPE_PRICE_EQUIPO" }[plan];
  const valor = process.env[env];
  return valor && valor.trim().length > 0 ? valor : undefined;
}

/** La suscripción de ESTA org (RLS la acota: sin WHERE, la política deja ver solo la suya). */
async function suscripcionDeOrg(c: PoolClient): Promise<{ estado?: string; clienteId?: string }> {
  const r = await c.query<{ estado: string; stripe_customer_id: string | null }>(
    "SELECT estado, stripe_customer_id FROM subscriptions",
  );
  const f = r.rows[0];
  return { estado: f?.estado, clienteId: f?.stripe_customer_id ?? undefined };
}

/**
 * Abre el checkout para CONTRATAR `plan`. Devuelve la URL a la que redirigir.
 *
 * Solo para quien NO tiene suscripción viva (`pendiente` o `cancelada`). Cambiar de plan con una
 * suscripción activa va por el PORTAL — ver YaTieneSuscripcion.
 *
 * Reusa el `customer` si la org ya fue cliente antes: sin eso se crearía uno nuevo en Stripe y
 * `app_stripe_vincular` (write-once) rechazaría el segundo — el cliente pagaría y el producto
 * seguiría creyéndole al customer viejo.
 */
export async function iniciarCheckout(
  c: PoolClient,
  pasarela: Pasarela,
  args: { orgId: string; plan: PlanPagable; origen: string },
): Promise<{ url: string }> {
  // Kill-switch de cobros ANTES de mandar a nadie a pagar: si hay un incidente de facturación, lo
  // último que queremos es seguir aceptando dinero que no vamos a poder conciliar.
  await exigirCobrosActivos(c);

  const sus = await suscripcionDeOrg(c);
  // 'morosa' también cuenta como viva: la suscripción existe en Stripe y lo que falló fue un cobro.
  // Mandarla al checkout crearía una SEGUNDA en vez de arreglar la tarjeta de la primera.
  if (sus.estado === "activa" || sus.estado === "morosa") throw new YaTieneSuscripcion();

  const priceId = precioDePlan(args.plan);
  if (!priceId) throw new PagosNoConfigurados(`falta el precio del plan ${args.plan}`);
  // AMBIGÜEDAD: dos planes con el MISMO price. Es la mala configuración cara y silenciosa —se
  // cobraría un plan y se entregaría otro, y el webhook (que solo ve el price) tendría razón al
  // entregar el que no es. No se puede detectar preguntándole a `planDePrecio`: su mapa es un
  // objeto literal, así que con la llave repetida gana el ÚLTIMO y responde tan campante. Hay que
  // contar cuántos planes reclaman este price.
  const duenos = PLANES_PAGABLES.filter((p) => precioDePlan(p) === priceId);
  if (duenos.length !== 1) throw new PagosNoConfigurados(`el precio de ${args.plan} está asignado también a ${duenos.filter((p) => p !== args.plan).join(", ")}`);
  // Cinturón y tirantes: que la dirección que usa el WEBHOOK coincida con la que se va a cobrar.
  if (planDePrecio(priceId) !== args.plan) throw new PagosNoConfigurados(`el precio de ${args.plan} mapea a "${planDePrecio(priceId) ?? "nada"}"`);

  const url = await pasarela.crearCheckout({
    orgId: args.orgId,
    priceId,
    clienteId: sus.clienteId,
    exitoUrl: `${args.origen}/cuenta?pago=listo`,
    cancelUrl: `${args.origen}/cuenta?pago=cancelado`,
  });
  return { url };
}

/**
 * Abre el portal de cliente de Stripe: cambiar tarjeta, ver facturas, CAMBIAR DE PLAN y cancelar.
 * Lanza SinSuscripcion si la org nunca pagó (lo que necesita entonces es el checkout).
 *
 * A propósito NO consulta el kill-switch de cobros: el portal es la única puerta por la que un
 * cliente moroso arregla su tarjeta o cancela. Cerrarlo durante un incidente de facturación deja
 * atrapada a la gente que quiere ponerse al corriente — o dejar de pagar, que también es su derecho.
 */
export async function abrirPortalCliente(
  c: PoolClient,
  pasarela: Pasarela,
  args: { origen: string },
): Promise<{ url: string }> {
  const { clienteId } = await suscripcionDeOrg(c);
  if (!clienteId) throw new SinSuscripcion();
  return { url: await pasarela.abrirPortal({ clienteId, volverUrl: `${args.origen}/cuenta` }) };
}
