import { type PoolClient } from "pg";
import { type Evento } from "./receptor.ts";
import { fallarAjuste } from "../ciclo/servicio.ts";
import { emitirEnTx } from "../ops/incidentes.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Los `procesar` de los webhooks (corren en la tx de dedupe del receptor, con el rol
// no-super `automata_webhook` sujeto a RLS). Descubren la org por LOOKUP del recurso
// FIRMADO usando los RESOLVERS SECURITY DEFINER (única forma de leer cross-org sin
// contexto); luego fijan app.current_org y operan bajo RLS. Sin los resolvers + set_config,
// el rol no-super veía/mutaba 0 filas → no-op permanente (hallazgo ALTA de la revisión).
// ─────────────────────────────────────────────────────────────────────────────

// data.type REALES de CMA (docs Managed Agents §webhooks). El webhook es THIN: NO dice si el
// build PASÓ — eso lo decide cosechar() re-consultando la sesión (outcome_evaluations). Por eso:
//   · status_idled     → ENCOLA en cosecha_pendiente (outbox); el drainer cosecha FUERA de esta
//                        tx (el I/O externo a CMA/R2 no debe colgar la tx del receptor ni el pool).
//   · status_terminated→ error terminal → fallarAjuste in-tx (UPDATE barato, libera el 'en vuelo').
//   · resto            → informativos (grader por iteración, arranques, threads): no-op.
const CMA_COSECHA = "session.status_idled";
const CMA_FALLO = "session.status_terminated";
const CMA_IGNORAR = new Set(["session.status_scheduled", "session.status_run_started", "session.outcome_evaluation_ended", "session.thread_created", "session.thread_idled"]);

async function fijarOrg(c: PoolClient, org: string): Promise<void> {
  await c.query("SELECT set_config('app.current_org', $1, true)", [org]);
}

/**
 * Webhook de fin/estado de sesión de CMA. Resuelve sesión FIRMADA → versión por el resolver SD
 * (cross-org). Un `status_idled` sobre una versión 'building' se ENCOLA en el outbox (idempotente
 * por session_id); el drainer hará el fetch de CMA + R2 + confirmarAjuste. `status_terminated`
 * falla el ajuste in-tx. Un idle tras el reaper (ya 'failed') = entregable pagado perdido → alerta.
 * Tipo desconocido → incidente + no-op (falla seguro).
 */
export async function procesarCma(c: PoolClient, evento: Evento): Promise<void> {
  if (evento.recurso.fuente !== "cma") return;
  const cosecha = evento.tipo === CMA_COSECHA;
  const fallo = evento.tipo === CMA_FALLO;
  if (!cosecha && !fallo) {
    if (!CMA_IGNORAR.has(evento.tipo)) {
      // Tipo no reconocido = build que podría colgarse; incidente durable (a2) para que ops lo
      // vea en minutos, no a las 6h del reaper. Sin org aún (pre-resolución) → org_id NULL.
      await emitirEnTx(c, { tipo: "webhook_desconocido", severidad: "media", detalle: `CMA data.type no reconocido: '${evento.tipo}'` });
      console.error(`[webhook:cma] tipo NO reconocido '${evento.tipo}' — confirmar la allowlist contra los docs de CMA (build podría quedar colgado).`);
    }
    return; // no-op (ack)
  }

  const r = await c.query<{ version_id: string; auto_id: string; org_id: string; estado: string }>(
    "SELECT version_id, auto_id, org_id, estado FROM resolver_sesion_cma($1)",
    [evento.recurso.sessionId],
  );
  const v = r.rows[0];
  if (!v) return; // sesión desconocida → ack, no-op
  if (v.estado !== "building") {
    // Ya resuelta. Un idle/cosecha tras el reaper (ya 'failed') = build pagado no entregado.
    if (cosecha && v.estado === "failed") {
      await emitirEnTx(c, { tipo: "pago_no_entregado", severidad: "alta", orgId: v.org_id, autoId: v.auto_id, versionId: v.version_id, detalle: "idle de CMA tras reaper: versión ya 'failed'" });
      console.error(`[webhook:cma] idle tras reaper: versión ${v.version_id} ya 'failed' — build pagado NO entregado, reconciliar.`);
    }
    return; // 'lista' (ya cosechada) → no-op idempotente
  }

  if (fallo) {
    await fijarOrg(c, v.org_id); // fallarAjuste opera bajo RLS
    await fallarAjuste(c, v.auto_id, v.version_id); // libera el 'en vuelo' sin esperar el reaper
    return;
  }
  // COSECHA: encolar en el outbox (idempotente por session_id PK). NO se cosecha aquí — el
  // drainer (owner) hace el I/O externo fuera de la tx del receptor. org_id del resolver FIRMADO.
  await c.query(
    "INSERT INTO cosecha_pendiente (session_id, version_id, auto_id, org_id) VALUES ($1,$2,$3,$4) ON CONFLICT (session_id) DO NOTHING",
    [evento.recurso.sessionId, v.version_id, v.auto_id, v.org_id],
  );
}

// Eventos de Stripe cuyo TIPO determina el estado sin leer el payload.
const STRIPE_ESTADO: Record<string, "activa" | "morosa" | "cancelada"> = {
  "customer.subscription.deleted": "cancelada",
  "invoice.payment_failed": "morosa",
  "invoice.payment_succeeded": "activa",
};

/**
 * Webhook de Stripe: resuelve org por stripe_customer_id (resolver SD, cross-org), fija
 * app.current_org y transiciona el estado con GUARD MONÓTONO — un evento MÁS VIEJO (Stripe
 * no garantiza orden y reintenta) no regresa el estado (p.ej. un payment_failed retrasado
 * tras un payment_succeeded ya aplicado). El CAMBIO DE PLAN necesita el price del evento o
 * re-fetch al SDK → PENDIENTE. Cross-contaminación entre productos del mismo customer →
 * PENDIENTE (discriminar por subscription/price al cablear el SDK).
 */
export async function procesarStripe(c: PoolClient, evento: Evento): Promise<void> {
  if (evento.recurso.fuente !== "stripe") return;
  const estado = STRIPE_ESTADO[evento.tipo];
  const cust = evento.recurso.customerId;
  if (!estado || !cust) return; // evento no accionable o sin customer → no-op

  const r = await c.query<{ org_id: string | null }>("SELECT resolver_org_stripe($1) AS org_id", [cust]);
  const org = r.rows[0]?.org_id;
  if (!org) return; // customer no mapeado a ninguna org → no-op

  await fijarOrg(c, org); // RLS: el WHERE org_id se satisface con el contexto (rol no-super)
  if (evento.ts === undefined) {
    // Sin `created` no se puede ordenar (no debería pasar en Stripe): aplica (fail-open,
    // mejor que dropear un evento legítimo) sin avanzar el guard.
    await c.query("UPDATE subscriptions SET estado = $1 WHERE org_id = $2", [estado, org]);
    return;
  }
  // Solo aplica si es ESTRICTAMENTE más nuevo que el último aplicado (anti out-of-order):
  // un payment_failed retrasado NO regresa a morosa una org que ya pagó.
  await c.query(
    "UPDATE subscriptions SET estado = $1, ultimo_evento_ts = $2 WHERE org_id = $3 AND coalesce(ultimo_evento_ts, 0) < $2",
    [estado, evento.ts, org],
  );
}
