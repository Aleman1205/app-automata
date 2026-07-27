import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Pool } from "pg";
import type { BuildClientAsync, Spec, Storage } from "../types.ts";
import type { PlanResultado } from "../planner/schema.ts";
import { PgStateRepo } from "../state/pg.ts";
import { arrancarConstruccion } from "./build-pipeline.ts";
import { registrarIncidente } from "../ops/incidentes.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Drainer del DISPARO de build (a3-s6): saca solicitudes de build_pendiente (que el endpoint
// encoló) y, FUERA del request, corre el planner (vista+contrato) y arrancarConstruccion
// (reserva la versión + arranca la sesión de CMA). Igual que la cosecha: el I/O de modelo +
// CMA no va en la tx del request. Corre con el pool DUEÑO. planeador/cosechador/storage se
// INYECTAN → se prueba con dobles, sin credenciales.
// ─────────────────────────────────────────────────────────────────────────────

export interface Planeador {
  planear(spec: Spec): Promise<PlanResultado>;
}
export interface DisparoDeps {
  pool: Pool; // DUEÑO
  planeador: Planeador;
  cosechador: BuildClientAsync;
  storage: Storage;
  ahora: () => string; // reloj inyectado (el core no usa Date directo)
}
const MAX_INTENTOS = 3;

export async function drenarBuilds(deps: DisparoDeps, opts?: { lote?: number }): Promise<{ arrancados: number; fallidos: number; pendientes: number }> {
  const lote = opts?.lote ?? 10;
  let arrancados = 0, fallidos = 0, pendientes = 0;
  const vistos = new Set<string>();
  for (let i = 0; i < lote; i++) {
    const claim = await deps.pool.query<{ id: string; org_id: string; nombre: string; spec: Spec; ejemplo_key: string; intentos: number }>(
      `UPDATE build_pendiente SET intentos = intentos + 1
         WHERE id = (SELECT id FROM build_pendiente ORDER BY creada FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, org_id, nombre, spec, ejemplo_key, intentos`,
    );
    const row = claim.rows[0];
    if (!row) break;
    if (vistos.has(row.id)) break; // ya recorrimos lo pendiente
    vistos.add(row.id);
    try {
      // 1. Planner → vista + contrato (modelo, fuera del request).
      const plan = await deps.planeador.planear(row.spec);
      // 2. El ejemplo vive en storage; arrancarConstruccion espera una RUTA → se baja a un temp.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "disparo-"));
      try {
        const ejemploPath = path.join(dir, path.basename(row.ejemplo_key));
        await fs.writeFile(ejemploPath, await deps.storage.get(row.ejemplo_key));
        // 3. Reserva la versión (cobrar_build) + arranca CMA + graba cma_session_id.
        await arrancarConstruccion(
          { state: new PgStateRepo(deps.pool, row.org_id), cosechador: deps.cosechador, ahora: deps.ahora },
          { orgId: row.org_id, nombre: row.nombre, spec: row.spec, vista: plan.vista, ejemploPath, contratoTexto: JSON.stringify(plan.resultado_contrato) },
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      await deps.pool.query("DELETE FROM build_pendiente WHERE id = $1", [row.id]);
      arrancados++;
    } catch (e) {
      // Un fallo puede ser transitorio (CMA/red) o de negocio (cuota/kill-switch al reservar).
      // Se reintenta hasta MAX_INTENTOS; luego se descarta con incidente (no colgar el outbox).
      if (row.intentos >= MAX_INTENTOS) {
        await registrarIncidente(deps.pool, { tipo: "otro", severidad: "alta", orgId: row.org_id, detalle: `disparo de build descartado tras ${row.intentos} intentos: ${(e as { message?: string })?.message ?? e}` }).catch(() => {});
        await deps.pool.query("DELETE FROM build_pendiente WHERE id = $1", [row.id]);
        fallidos++;
      } else {
        pendientes++;
        console.error(`[disparo] error arrancando build ${row.id} (intento ${row.intentos}, se reintenta):`, (e as { message?: string })?.message ?? e);
      }
    }
  }
  return { arrancados, fallidos, pendientes };
}
