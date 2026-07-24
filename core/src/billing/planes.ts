// ─────────────────────────────────────────────────────────────────────────────
// El contrato de planes (docs/06 §8). Es la ÚNICA fuente de los límites; la tabla
// `subscriptions` solo guarda QUÉ plan tiene cada org, no CUÁNTO da cada plan.
// Puro y sin DB → se testea gratis (verify-cuota.ts).
//
//   stock  = espacios: cuántas automatizaciones ACTIVAS puede tener (docs/06 §3)
//   flujo  = generaciones/mes: cuántos builds-que-llegan-a-ready puede generar
//            (el tope anti-desangre = 2× espacios, docs/06 §4)
//   corte  = ejecuciones/mes: tope DURO que corta (no solo alarma, docs/11 §8)
// ─────────────────────────────────────────────────────────────────────────────

export type Plan = "base" | "pro" | "equipo";

export interface Entitlements {
  espaciosActivos: number; // stock  — automatizaciones activas simultáneas
  generacionesMes: number; // flujo  — builds a `ready` por mes
  ejecucionesMes: number; // corte  — ejecuciones por mes (tope duro)
  usuarios: number; // miembros de la org (admin + operador)
  exportarCodigo: boolean; // sacar el código fuente del artefacto (solo Equipo)
  reparacionesMes: number; // circuit breaker: reparaciones/mes/automatización antes de escalar a revisión (docs/08 §2)
}

export const PLANES: Record<Plan, Entitlements> = {
  base: { espaciosActivos: 3, generacionesMes: 6, ejecucionesMes: 500, usuarios: 1, exportarCodigo: false, reparacionesMes: 10 },
  pro: { espaciosActivos: 6, generacionesMes: 12, ejecucionesMes: 2000, usuarios: 3, exportarCodigo: false, reparacionesMes: 10 },
  equipo: { espaciosActivos: 10, generacionesMes: 20, ejecucionesMes: 10000, usuarios: 10, exportarCodigo: true, reparacionesMes: 10 },
};

export function esPlan(x: unknown): x is Plan {
  return x === "base" || x === "pro" || x === "equipo";
}

/**
 * Entitlements de un plan. Fail-closed: un plan desconocido/ausente LANZA en vez
 * de asumir uno permisivo — quien no tenga plan válido no debe poder consumir.
 */
export function entitlementsDe(plan: unknown): Entitlements {
  if (!esPlan(plan)) {
    throw new Error(`Plan inválido o ausente: ${JSON.stringify(plan)}. No se puede derivar cuota (fail-closed).`);
  }
  return PLANES[plan];
}
