import { type PoolClient } from "pg";
import { type Evento } from "./receptor.ts";
import { confirmarAjuste, fallarAjuste } from "../ciclo/servicio.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Los `procesar` de los webhooks (corren en la tx de dedupe del receptor, con el rol
// no-super `automata_webhook` sujeto a RLS). Descubren la org por LOOKUP del recurso
// FIRMADO usando los RESOLVERS SECURITY DEFINER (única forma de leer cross-org sin
// contexto); luego fijan app.current_org y operan bajo RLS. Sin los resolvers + set_config,
// el rol no-super veía/mutaba 0 filas → no-op permanente (hallazgo ALTA de la revisión).
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ CABLEAR: confirmar los `data.type` EXACTOS de CMA contra los docs de Managed Agents.
// Allowlist explícita; un tipo desconocido NO se actúa (seguro) pero se ALERTA (para que un
// string mal cableado se detecte en minutos, no a las 6h del reaper).
const CMA_EXITO = new Set(["session.completed", "session.succeeded", "session.ready"]);
const CMA_FALLO = new Set(["session.failed", "session.errored", "session.expired", "session.canceled", "session.cancelled", "session.stopped"]);
// Tipos informativos de CMA que se ignoran a propósito (no gatean nada). Ajustar al cablear.
const CMA_IGNORAR = new Set(["session.started", "session.log", "session.progress", "event"]);

async function fijarOrg(c: PoolClient, org: string): Promise<void> {
  await c.query("SELECT set_config('app.current_org', $1, true)", [org]);
}

/**
 * Fin de build de CMA. Resuelve sesión FIRMADA → versión por resolver SD (cross-org),
 * fija app.current_org y cierra el ciclo (FALLO → fallarAjuste, libera el "en vuelo" YA;
 * ÉXITO → confirmarAjuste + clave del artefacto). Un ÉXITO que llega tras el reaper (versión
 * ya 'failed') se ALERTA (entregable pagado perdido). Tipo desconocido → alerta, no-op.
 */
export async function procesarCma(c: PoolClient, evento: Evento): Promise<void> {
  if (evento.recurso.fuente !== "cma") return;
  const exito = CMA_EXITO.has(evento.tipo);
  const fallo = CMA_FALLO.has(evento.tipo);
  if (!exito && !fallo) {
    if (!CMA_IGNORAR.has(evento.tipo)) {
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
    // Ya resuelta. Un ÉXITO tras el reaper (ya 'failed') = build pagado no entregado → reconciliar.
    if (exito && v.estado === "failed") {
      console.error(`[webhook:cma] ÉXITO tras reaper: versión ${v.version_id} ya 'failed' — build pagado NO entregado, reconciliar.`);
    }
    return;
  }

  await fijarOrg(c, v.org_id);
  if (fallo) {
    await fallarAjuste(c, v.auto_id, v.version_id); // libera el "en vuelo" sin esperar el reaper
    return;
  }
  await confirmarAjuste(c, v.auto_id, v.version_id); // building→lista + consume ajuste (savepoint anti-brick)
  // Clave determinista (los bytes los sube el pipeline a R2 en esta misma clave; ejecutar la
  // recomputa de version.id). PENDIENTE (revisión): al cablear R2, verificar que los bytes
  // existan ANTES de dejar la versión 'lista' (evitar 'lista' no ejecutable).
  await c.query("UPDATE versiones SET artefacto_key = 'artefactos/' || id || '.json' WHERE id = $1", [v.version_id]);
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
