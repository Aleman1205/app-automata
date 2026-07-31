import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Pool } from "pg";
import type { BuildClientAsync, Spec, Storage } from "../types.ts";
import type { PlanResultado } from "../planner/schema.ts";
import { PgStateRepo } from "../state/pg.ts";
import { arrancarConstruccion } from "./build-pipeline.ts";
import { registrarIncidente } from "../ops/incidentes.ts";
import type { Notificador } from "../ops/notificaciones.ts";

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
  notificador?: Notificador; // opcional: avisa por correo si el build se descarta (best-effort)
}
const MAX_INTENTOS = 3;

export async function drenarBuilds(deps: DisparoDeps, opts?: { lote?: number }): Promise<{ arrancados: number; fallidos: number; pendientes: number }> {
  const lote = opts?.lote ?? 10;
  let arrancados = 0, fallidos = 0, pendientes = 0;
  const vistos: string[] = [];
  for (let i = 0; i < lote; i++) {
    // Las ya vistas se EXCLUYEN en el SELECT, no después de reclamarlas: reclamar para luego
    // descartar la fila incrementaba `intentos` sin procesarla, y así el presupuesto de
    // reintentos se gastaba al doble (una fila se descartaba tras 2 intentos reales, no 3).
    const claim = await deps.pool.query<{ id: string; org_id: string; nombre: string; spec: Spec; ejemplo_key: string; intentos: number }>(
      // ARRENDAMIENTO (`tomada_en`): solo se reclama lo libre o lo vencido. El lock del claim muere
      // con el UPDATE (autocommit) y el trabajo caro —planner + sesión de CMA, decenas de segundos—
      // corre FUERA de él, así que dos corridas de cron solapadas reclamaban la MISMA fila y
      // construían y COBRABAN el mismo build dos o tres veces (~$1.8 cada uno). Nada aguas abajo lo
      // rescataba: arrancarConstruccion crea una automatización nueva cada vez.
      `UPDATE build_pendiente SET intentos = intentos + 1, tomada_en = now()
         WHERE id = (SELECT id FROM build_pendiente
                      WHERE NOT (id = ANY($1::uuid[]))
                        AND (tomada_en IS NULL OR tomada_en < now() - interval '15 minutes')
                      ORDER BY creada FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, org_id, nombre, spec, ejemplo_key, intentos`,
      [vistos],
    );
    const row = claim.rows[0];
    if (!row) break; // no queda nada pendiente que no hayamos recorrido
    vistos.push(row.id);
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
          // `ejemploKey` (la CLAVE, no la ruta temporal) se persiste en la automatización: es lo
          // único con que un AJUSTE futuro puede volver a probar con los datos del cliente. Sin
          // ella, arrancarAjuste descarta el ajuste con "la automatización no guardó su
          // spec/ejemplo". Se pasaba `ejemploPath` —un temp que se borra al terminar— y la clave
          // se quedaba solo en build_pendiente, que el drainer borra.
          {
            orgId: row.org_id,
            nombre: row.nombre,
            spec: row.spec,
            vista: plan.vista,
            ejemploPath,
            ejemploKey: row.ejemplo_key,
            contratoTexto: JSON.stringify(plan.resultado_contrato),
          },
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
        // AVISAR AL CLIENTE. El incidente es para operaciones; sin este correo el cliente se
        // queda con el "ya está construyendo, te avisamos" de la pantalla de cierre y NADIE le
        // dice que no va a llegar (la automatización nunca se creó, así que su portafolio ni la
        // muestra). Best-effort: el descarte ya ocurrió, un correo caído no lo revierte.
        await deps.notificador?.notificar({ tipo: "fallo", orgId: row.org_id, nombre: row.nombre }).catch(() => {});
        fallidos++;
      } else {
        pendientes++;
        // SOLTAR el arrendamiento al fallar: protege el trabajo EN VUELO, no debe retrasar el
        // reintento. Sin esto una falla transitoria dejaba la fila apartada 15 min antes de
        // reintentarse — y el presupuesto de 3 intentos tardaba 45 min en agotarse.
        await deps.pool.query("UPDATE build_pendiente SET tomada_en = NULL WHERE id = $1", [row.id]).catch(() => {});
        console.error(`[disparo] error arrancando build ${row.id} (intento ${row.intentos}, se reintenta):`, (e as { message?: string })?.message ?? e);
      }
    }
  }
  return { arrancados, fallidos, pendientes };
}
