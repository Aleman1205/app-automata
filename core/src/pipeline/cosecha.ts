import { type Pool } from "pg";
import type { Artefacto, BuildClientAsync, Storage, Vista } from "../types.ts";
import { confirmarAjuste, fallarAjuste } from "../ciclo/servicio.ts";
import { registrarIncidente } from "../ops/incidentes.ts";
import type { Notificador } from "../ops/notificaciones.ts";

// ─────────────────────────────────────────────────────────────────────────────
// La COSECHA (a3): el webhook thin de CMA solo ENCOLA en cosecha_pendiente; aquí, FUERA de
// la tx del receptor, un drainer (rol DUEÑO, como el reaper) re-consulta la sesión, ensambla
// el Artefacto con la vista persistida, lo sube a storage, VERIFICA que los bytes existan
// (guard: no marcar 'lista' sin artefacto ejecutable) y confirma el ajuste. Cierra el loop
// async del build. cosechador/storage se INYECTAN → se prueba con dobles, sin credenciales.
//
// El drainer corre con el pool DUEÑO (bypassa RLS, como reaparBuildsColgados): opera sobre
// version_ids que vienen del OUTBOX (escrito por el resolver FIRMADO), no del payload. La org
// se fija en app.current_org para que app_consumir_ajuste cuente en el tenant correcto.
// ─────────────────────────────────────────────────────────────────────────────

export interface CosechaDeps {
  pool: Pool; // DUEÑO
  cosechador: BuildClientAsync;
  storage: Storage;
  notificador?: Notificador; // opcional: avisa por correo al confirmar/fallar (best-effort)
}

// Notifica sin tumbar el flujo: el build YA se resolvió; un correo caído no debe fallar la cosecha.
async function avisar(deps: CosechaDeps, tipo: "lista" | "fallo", item: ItemCosecha): Promise<void> {
  try {
    await deps.notificador?.notificar({ tipo, orgId: item.orgId, automatizacionId: item.autoId });
  } catch (e) {
    console.error(`[cosecha] no se pudo notificar (${tipo}) ${item.autoId}:`, (e as { message?: string })?.message ?? e);
  }
}
export interface ItemCosecha {
  sessionId: string;
  versionId: string;
  autoId: string;
  orgId: string;
}
export type EstadoCosecha = "cosechado" | "fallido" | "en_curso" | "sin_bytes";

function artefactoKey(versionId: string): string {
  return `artefactos/${versionId}.json`;
}

/** Cosecha UNA sesión: re-consulta CMA (cosechar), y según el desenlace ensambla+sube+confirma,
 *  falla, o deja en curso. El I/O externo (CMA/storage) va FUERA de la tx de BD; la mutación de
 *  BD (confirmar/fallar) va en una tx corta con app.current_org fijado. Idempotente. */
export async function cosecharYConfirmar(deps: CosechaDeps, item: ItemCosecha): Promise<EstadoCosecha> {
  const r = await deps.cosechador.cosechar(item.sessionId);
  if (r.estado === "en_curso") return "en_curso"; // aún sin veredicto → reintentar luego

  const c = await deps.pool.connect();
  try {
    if (r.estado === "fallido") {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_org', $1, true)", [item.orgId]);
      await fallarAjuste(c, item.autoId, item.versionId); // building→failed (libera el 'en vuelo')
      await c.query("COMMIT");
      await avisar(deps, "fallo", item); // correo "necesita revisión" (best-effort, fuera de tx)
      return "fallido";
    }

    // satisfecho: la vista se persistió al arrancar. Se lee como DUEÑO (bypassa RLS) acotando por
    // (id, org) del outbox firmado. Si ya no está 'building', otra corrida la cosechó (idempotente).
    const vr = await c.query<{ vista: unknown; estado: string }>("SELECT vista, estado FROM versiones WHERE id = $1 AND org_id = $2", [item.versionId, item.orgId]);
    const row = vr.rows[0];
    if (!row) return "cosechado"; // versión purgada/ausente → nada que hacer
    if (row.estado !== "building") return "cosechado"; // ya resuelta

    const key = artefactoKey(item.versionId);
    const artefacto: Artefacto = { ...r.codigo, vista: (row.vista as Vista) ?? undefined as unknown as Vista };
    await deps.storage.put(key, JSON.stringify(artefacto)); // I/O externo, FUERA de tx

    // GUARD DE BYTES: no confirmar 'lista' si el artefacto no quedó en storage (evita una
    // versión no ejecutable). Si put resolvió pero existe() dice que no, es un incidente.
    if (!(await deps.storage.existe(key))) {
      await registrarIncidente(deps.pool, { tipo: "cosecha_fallida", severidad: "alta", orgId: item.orgId, autoId: item.autoId, versionId: item.versionId, detalle: "artefacto ausente en storage tras put — NO se marca 'lista'" });
      return "sin_bytes"; // se deja en el outbox para reintento
    }

    await c.query("BEGIN");
    await c.query("SELECT set_config('app.current_org', $1, true)", [item.orgId]);
    await confirmarAjuste(c, item.autoId, item.versionId); // building→lista + consume ajuste (savepoint anti-brick)
    await c.query("UPDATE versiones SET artefacto_key = $2 WHERE id = $1 AND estado = 'lista'", [item.versionId, key]);
    await c.query("COMMIT");
    await avisar(deps, "lista", item); // correo "ya está lista" (best-effort, fuera de tx)
    return "cosechado";
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e; // técnico → el drainer lo deja en el outbox para reintento
  } finally {
    c.release();
  }
}

/** Drena el outbox: reclama filas (FOR UPDATE SKIP LOCKED, seguro con varios drainers),
 *  cosecha cada una, y borra las terminales. en_curso/sin_bytes se dejan para el próximo
 *  drenado (intentos las cuenta). Un error TÉCNICO deja la fila (reintento). */
export async function drenarCosecha(deps: CosechaDeps, opts?: { lote?: number }): Promise<{ cosechados: number; fallidos: number; pendientes: number }> {
  const lote = opts?.lote ?? 20;
  let cosechados = 0, fallidos = 0, pendientes = 0;
  // Cada fila se procesa a lo sumo UNA vez por drenado: los no-terminales (en_curso/sin_bytes)
  // se quedan en el outbox, así que sin esto el loop los re-reclamaría en círculo. Al re-encontrar
  // uno ya visto, ya dimos la vuelta a lo pendiente → cortamos.
  // Las ya vistas se EXCLUYEN en el SELECT, no después de reclamarlas. Con el chequeo posterior el
  // drenado se ATORABA en la primera fila no terminal: `en_curso` es el caso NORMAL (el webhook
  // encola en status_idled y la sesión todavía itera), esa fila se queda en el outbox, la siguiente
  // vuelta re-reclamaba LA MISMA y el guard cortaba el bucle. Resultado: los builds de los demás
  // clientes —ya terminados— no se cosechaban nunca y a las 6 h el reaper los marcaba 'failed'.
  // Mismo arreglo que en disparo.ts y ajuste.ts (que sí excluyen en el SELECT).
  const vistos: string[] = [];
  for (let i = 0; i < lote; i++) {
    const claim = await deps.pool.query<{ session_id: string; version_id: string; auto_id: string; org_id: string }>(
      `UPDATE cosecha_pendiente SET intentos = intentos + 1
         WHERE session_id = (SELECT session_id FROM cosecha_pendiente
                              WHERE NOT (session_id = ANY($1::text[]))
                              ORDER BY creada FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING session_id, version_id, auto_id, org_id`,
      [vistos],
    );
    const row = claim.rows[0];
    if (!row) break; // no queda nada pendiente que no hayamos recorrido
    vistos.push(row.session_id);
    const item: ItemCosecha = { sessionId: row.session_id, versionId: row.version_id, autoId: row.auto_id, orgId: row.org_id };
    let estado: EstadoCosecha;
    try {
      estado = await cosecharYConfirmar(deps, item);
    } catch (e) {
      pendientes++;
      console.error(`[cosecha] error técnico cosechando ${item.sessionId} (se reintenta):`, (e as { message?: string })?.message ?? e);
      continue; // deja la fila en el outbox
    }
    if (estado === "cosechado" || estado === "fallido") {
      await deps.pool.query("DELETE FROM cosecha_pendiente WHERE session_id = $1", [row.session_id]);
      if (estado === "cosechado") cosechados++; else fallidos++;
    } else {
      pendientes++; // en_curso / sin_bytes → se queda para reintento
    }
  }
  return { cosechados, fallidos, pendientes };
}
