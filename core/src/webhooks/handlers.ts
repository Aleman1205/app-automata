import { type PoolClient } from "pg";
import { type Evento } from "./receptor.ts";
import { confirmarAjuste, fallarAjuste } from "../ciclo/servicio.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Los `procesar` de los webhooks (lo que corre DENTRO de la tx de dedupe del receptor,
// con la conexión de DUEÑO). Derivan la org por LOOKUP del recurso FIRMADO en NUESTRA DB
// (nunca del payload). Si lanzan, el receptor hace rollback y libera el id (reintento).
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ CABLEAR: confirmar los `data.type` EXACTOS de CMA contra los docs de Managed Agents.
// Allowlist explícita + no-op por defecto: ante un tipo desconocido NO se actúa (seguro;
// el reaper de builds huérfanos es el backstop). Nunca clasifica por adivinanza.
const CMA_EXITO = new Set(["session.completed", "session.succeeded", "session.ready"]);
const CMA_FALLO = new Set(["session.failed", "session.errored", "session.expired", "session.canceled", "session.cancelled", "session.stopped"]);

/**
 * Fin de build de CMA: mapea la sesión firmada → la versión 'building' y cierra el ciclo.
 * FALLO → fallarAjuste (libera el "en vuelo" YA, sin esperar el reaper de 6h). ÉXITO →
 * confirmarAjuste (building→lista + consume el ajuste) y fija la clave determinista del
 * artefacto (los bytes viven en R2 en esa misma clave). Corre como DUEÑO; se fija
 * app.current_org de la versión para que app_consumir_ajuste (SECURITY DEFINER) y la RLS
 * (FORCE, incluso para el dueño) operen en el contexto correcto.
 */
export async function procesarCma(c: PoolClient, evento: Evento): Promise<void> {
  if (evento.recurso.fuente !== "cma") return;
  const exito = CMA_EXITO.has(evento.tipo);
  const fallo = CMA_FALLO.has(evento.tipo);
  if (!exito && !fallo) return; // tipo no accionable → ack (no-op)

  const r = await c.query<{ id: string; automatizacion_id: string; org_id: string }>(
    "SELECT id, automatizacion_id, org_id FROM versiones WHERE cma_session_id = $1 AND estado = 'building'",
    [evento.recurso.sessionId],
  );
  const v = r.rows[0];
  if (!v) return; // sesión desconocida o versión ya resuelta → ack, no-op

  await c.query("SELECT set_config('app.current_org', $1, true)", [v.org_id]);
  if (fallo) {
    await fallarAjuste(c, v.automatizacion_id, v.id);
    return;
  }
  await confirmarAjuste(c, v.automatizacion_id, v.id); // building→lista + consume ajuste
  // Clave determinista del artefacto (los bytes los sube el pipeline/R2 a esta misma clave;
  // ejecutar la recomputa de version.id — no confía en la columna).
  await c.query("UPDATE versiones SET artefacto_key = 'artefactos/' || id || '.json' WHERE id = $1", [v.id]);
}

// Eventos de Stripe cuyo TIPO determina el estado de la suscripción sin leer el payload.
const STRIPE_ESTADO: Record<string, "activa" | "morosa" | "cancelada"> = {
  "customer.subscription.deleted": "cancelada",
  "invoice.payment_failed": "morosa",
  "invoice.payment_succeeded": "activa",
};

/**
 * Webhook de Stripe: deriva la org por `stripe_customer_id` (firmado) y actualiza el
 * ESTADO de la suscripción (morosa/cancelada/activa) — que es lo que gatea si la org
 * puede construir/ejecutar. El CAMBIO DE PLAN (up/downgrade) necesita el price del evento
 * o un re-fetch al API de Stripe (SDK) → PENDIENTE de cablear; aquí se ignora (no-op).
 */
export async function procesarStripe(c: PoolClient, evento: Evento): Promise<void> {
  if (evento.recurso.fuente !== "stripe") return;
  const estado = STRIPE_ESTADO[evento.tipo];
  if (!estado) return; // otros eventos (plan, etc.) → no-op por ahora
  const cust = evento.recurso.customerId;
  if (!cust) return;
  // 0 filas si el customer no está mapeado a ninguna org → no-op (el ack corta reintentos).
  await c.query("UPDATE subscriptions SET estado = $1 WHERE stripe_customer_id = $2", [estado, cust]);
}
