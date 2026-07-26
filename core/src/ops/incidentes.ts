import { type Pool, type PoolClient } from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// Incidentes durables (a2, auditoría de riesgo). Reemplazan los console.error de dinero/
// entrega que se perdían sin lector. Se escriben vía el SD app_registrar_incidente (la
// tabla tiene REVOKE ALL). Ops los consulta con incidentesAbiertos y cierra con resolver.
//
// FIX CRÍTICO (re-brick): emitir un incidente DENTRO de una tx (p.ej. confirmarAjuste)
// con un try/catch normal NO sirve — si el INSERT falla por causa técnica, la tx queda
// ABORTada (25P02) y el siguiente query lanza; en confirmarAjuste eso revertiría el
// building→lista y ladrillaría la automatización (el brick que el SAVEPOINT evita). Por
// eso los caminos EN-TX usan emitirEnTx (SAVEPOINT + ROLLBACK TO SAVEPOINT), que deja la
// tx utilizable pase lo que pase con el sink.
// ─────────────────────────────────────────────────────────────────────────────

export type TipoIncidente =
  | "pago_no_entregado"
  | "entrega_sin_ajuste"
  | "webhook_desconocido"
  | "build_colgado"
  | "cosecha_fallida"
  | "otro";
export type Severidad = "baja" | "media" | "alta";

export interface Incidente {
  tipo: TipoIncidente;
  severidad?: Severidad;
  orgId?: string;
  autoId?: string;
  versionId?: string;
  detalle?: string;
}

/** Emite un incidente por el SD. Corre en la conexión/tx que se le pase (Pool en autocommit
 *  para el reaper/owner; PoolClient dentro de una tx SOLO vía emitirEnTx). */
export async function registrarIncidente(c: PoolClient | Pool, i: Incidente): Promise<void> {
  await c.query("SELECT app_registrar_incidente($1,$2,$3,$4,$5,$6)", [
    i.tipo,
    i.severidad ?? "media",
    i.orgId ?? null,
    i.autoId ?? null,
    i.versionId ?? null,
    i.detalle ?? null,
  ]);
}

/** Emite un incidente DENTRO de una tx sin poder abortarla: envuelve el INSERT en su propio
 *  SAVEPOINT. Si el sink falla, ROLLBACK TO SAVEPOINT deja la tx viva (y loguea de respaldo).
 *  Úsalo en confirmarAjuste y en los handlers de webhook (que corren en la tx del receptor). */
export async function emitirEnTx(c: PoolClient, i: Incidente): Promise<void> {
  try {
    await c.query("SAVEPOINT inc");
    await registrarIncidente(c, i);
    await c.query("RELEASE SAVEPOINT inc");
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT inc").catch(() => {});
    console.error(`[incidentes] no se pudo registrar '${i.tipo}' (${i.versionId ?? i.orgId ?? "?"}):`, (e as { message?: string })?.message ?? e);
  }
}

export interface IncidenteAbierto {
  id: string;
  tipo: TipoIncidente;
  severidad: Severidad;
  orgId: string | null;
  autoId: string | null;
  versionId: string | null;
  detalle: string | null;
  actor: string | null;
  cuando: string;
}

/** Panel pull-based de ops: incidentes sin resolver, los más graves/viejos primero. */
export async function incidentesAbiertos(owner: Pool): Promise<IncidenteAbierto[]> {
  const r = await owner.query<IncidenteAbierto>(
    `SELECT id::text, tipo, severidad, org_id AS "orgId", automatizacion_id AS "autoId",
            version_id AS "versionId", detalle, actor, cuando::text
       FROM incidentes WHERE resuelto IS NULL
      ORDER BY array_position(ARRAY['alta','media','baja']::text[], severidad), cuando`,
  );
  return r.rows;
}

/** Cierra un incidente (owner/ops). Idempotente: solo mueve los abiertos. */
export async function resolverIncidente(owner: Pool, id: string, por: string, nota?: string): Promise<void> {
  await owner.query("UPDATE incidentes SET resuelto = now(), resuelto_por = $2, nota = $3 WHERE id = $1 AND resuelto IS NULL", [id, por, nota ?? null]);
}
