import { type Pool, type PoolClient } from "pg";
import { comoCuota } from "./cuota.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Cambios de plan y el ciclo activa/inactiva (docs/06 §9). Al bajar de plan, las
// automatizaciones sobrantes NO se borran: quedan activa=false (solo lectura), y el
// cliente elige cuáles reactivar. La reactivación (activa false→true) la enforza el
// TRIGGER de espacios de M3 (BEFORE UPDATE OF activa, con advisory lock por-org) →
// no hace falta re-implementar el tope: reactivar es un UPDATE que el trigger corta si
// no hay espacio, y desactivar siempre se permite.
//
// aplicarDowngrade corre con la conexión de DUEÑO (muta subscriptions.plan, que el rol
// de app tiene revocado en M3), atómicamente: cambiar el plan y desactivar el excedente
// en UNA tx, sin ventana en la que el plan sea chico pero el excedente siga activo.
// reactivar/desactivar corren por conOrg (rol de app, RLS acota a la org). Son acción
// ADMIN ('gestionar_espacios', roles.ts): el endpoint las envuelve en withEfecto/assertCan
// (un operador no gestiona espacios). El motor no chequea rol aquí, igual que el resto.
// ─────────────────────────────────────────────────────────────────────────────

export class AutomatizacionNoEncontrada extends Error {
  constructor() { super("La automatización no existe en esta org."); this.name = "AutomatizacionNoEncontrada"; }
}

export interface Downgrade {
  plan: string;
  espacios: number;
  desactivadas: string[]; // ids que quedaron en solo lectura
}

/**
 * Cambia el plan de una org y, si tiene más automatizaciones activas que espacios del
 * plan nuevo, desactiva el EXCEDENTE conservando las MÁS ANTIGUAS activas (default
 * determinista; el cliente puede luego reactivar otras). Atómico. Dueño-only.
 */
export async function aplicarDowngrade(owner: Pool, orgId: string, nuevoPlan: string): Promise<Downgrade> {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    // MISMO advisory lock por-org que el trigger de espacios (schema.sql). Sin esto, un
    // crearAutomatizacion/reactivar concurrente vería el plan viejo (o el conteo pre-
    // desactivación) y dejaría a la org POR ENCIMA del límite nuevo (oversell). Con el
    // lock, esa operación bloquea hasta el COMMIT del downgrade y re-evalúa el tope nuevo.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('espacio:' || $1::text))", [orgId]);
    const p = await c.query<{ espacios: number }>("SELECT espacios FROM planes WHERE plan = $1", [nuevoPlan]);
    const fila = p.rows[0];
    if (!fila) throw new Error(`Plan inválido: ${nuevoPlan}`);
    const espacios = fila.espacios;

    const sub = await c.query("UPDATE subscriptions SET plan = $2 WHERE org_id = $1 RETURNING org_id", [orgId, nuevoPlan]);
    if ((sub.rowCount ?? 0) === 0) throw new Error(`La org ${orgId} no tiene subscription.`);

    // Conserva las `espacios` más antiguas activas; desactiva el resto (activa=false
    // NO dispara el chequeo de cuota del trigger — solo la reactivación lo hace).
    const des = await c.query<{ id: string }>(
      `UPDATE automatizaciones SET activa = false
         WHERE id IN (
           SELECT id FROM automatizaciones WHERE org_id = $1 AND activa
             ORDER BY creada ASC, id ASC OFFSET $2
         )
       RETURNING id`,
      [orgId, espacios],
    );
    await c.query("COMMIT");
    return { plan: nuevoPlan, espacios, desactivadas: des.rows.map((r) => r.id) };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Reactiva una automatización en solo lectura (activa false→true). El trigger de M3
 * hace cumplir el tope de espacios: si el plan está lleno lanza CuotaExcedida('espacios').
 * Idempotente (reactivar una ya activa es no-op). Corre por conOrg.
 */
export async function reactivar(c: PoolClient, autoId: string): Promise<void> {
  const r = await c
    .query("UPDATE automatizaciones SET activa = true WHERE id = $1 RETURNING id", [autoId])
    .catch((e) => comoCuota(e)); // CUOTA_EXCEDIDA → CuotaExcedida; otro error se re-lanza
  if ((r.rowCount ?? 0) === 0) throw new AutomatizacionNoEncontrada();
}

/** Pone una automatización en solo lectura (libera un espacio). Siempre permitido. */
export async function desactivar(c: PoolClient, autoId: string): Promise<void> {
  const r = await c.query("UPDATE automatizaciones SET activa = false WHERE id = $1 RETURNING id", [autoId]);
  if ((r.rowCount ?? 0) === 0) throw new AutomatizacionNoEncontrada();
}

/** Para la UI: cuántos espacios usa la org y de cuántos dispone su plan. */
export async function usoDeEspacios(c: PoolClient): Promise<{ activas: number; limite: number }> {
  const r = await c.query<{ activas: number; limite: number }>(
    `SELECT (SELECT count(*)::int FROM automatizaciones WHERE activa) AS activas,
            (SELECT p.espacios FROM subscriptions s JOIN planes p ON p.plan = s.plan) AS limite`,
  );
  const f = r.rows[0];
  return { activas: f?.activas ?? 0, limite: f?.limite ?? 0 };
}
