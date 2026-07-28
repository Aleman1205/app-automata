import { type Pool } from "pg";
import type { Automatizacion, Ejecucion, EstadoBuild, StateRepo, Version } from "../types.ts";
import { conOrg } from "../db/pg.ts";
import { comoCuota } from "../billing/cuota.ts";
import { comoSuspension } from "../ops/killswitch.ts";

// ─────────────────────────────────────────────────────────────────────────────
// StateRepo contra Postgres (M2+): la MISMA interfaz que MemoryStateRepo, pero cada
// método corre por conOrg (rol NO-dueño automata_app + app.current_org de la org), así
// que TODO el enforcement de la BD aplica de verdad:
//   crearAutomatizacion → trg_cuota_espacio (stock del plan)
//   crearVersion (build) → cobrar_build (una generación al ARRANCAR) + trg_kill_build
//                          (kill-switch/suspensión) + trg_marcar_entrega (sella entrega)
//   crearEjecucion (run) → trg_kill_run
// Está ligado a UNA org (como una request): cada método abre su propia tx corta, que es
// el modelo de producción (cada paso del loop async —drainer de cron— es aparte, docs/03).
// RLS acota SELECT/UPDATE por id sin necesidad de pasar la org (fail-closed sin contexto).
// El app solo escribe lo que le toca: versiones(estado, artefacto_key); tipo/creada/
// contador viven en la BD (ver GRANT/REVOKE en schema.sql).
// ─────────────────────────────────────────────────────────────────────────────

interface AutoRow { id: string; org_id: string; nombre: string }
interface VerRow { id: string; automatizacion_id: string; numero: number; estado: EstadoBuild; artefacto_key: string | null; vista: unknown; cma_session_id: string | null; creada: Date | string }
interface EjecRow { id: string; version_id: string; estado: string; ms: number; costo_usd: string | number; resultado_key: string | null; creada: Date | string }

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
const aAutomatizacion = (r: AutoRow): Automatizacion => ({ id: r.id, orgId: r.org_id, nombre: r.nombre });
const aVersion = (r: VerRow): Version => ({
  id: r.id, automatizacionId: r.automatizacion_id, numero: r.numero, estado: r.estado,
  artefactoKey: r.artefacto_key ?? undefined,
  vista: (r.vista as Version["vista"]) ?? undefined,
  cmaSessionId: r.cma_session_id ?? undefined,
  creada: iso(r.creada),
});
const aEjecucion = (r: EjecRow): Ejecucion => ({
  id: r.id, versionId: r.version_id, estado: r.estado as Ejecucion["estado"],
  ms: r.ms, costoUsd: Number(r.costo_usd), resultadoKey: r.resultado_key ?? undefined, creada: iso(r.creada),
});

/** Traduce los RAISE de los triggers del build a errores tipados; re-lanza lo demás. */
function traducirBuild(e: unknown): never {
  const msg = (e as { message?: string })?.message ?? "";
  if (/CUOTA_EXCEDIDA:/.test(msg)) return comoCuota(e);
  if (/SERVICIO_SUSPENDIDO:/.test(msg)) return comoSuspension(e);
  throw e;
}

export class PgStateRepo implements StateRepo {
  constructor(private readonly pool: Pool, private readonly orgId: string) {}

  async crearAutomatizacion(a: Omit<Automatizacion, "id">): Promise<Automatizacion> {
    // Fail-closed: es el ÚNICO método donde el llamador declara la org y NO hay FK padre
    // que respalde el binding (automatizaciones es la raíz). Un repo mal-vinculado (org Y)
    // que reciba orgId=X debe FALLAR, no escribir en el tenant equivocado en silencio.
    if (a.orgId && a.orgId !== this.orgId) {
      throw new Error(`PgStateRepo mal-vinculado: repo ligado a ${this.orgId}, se pidió crear en ${a.orgId}`);
    }
    // org_id = app_current_org() (RLS-consistente). El ciclo (ciclo_estado/ajustes_usados/
    // entregada/en_revision) lo normaliza el trigger.
    const r = await conOrg(this.pool, this.orgId, (c) =>
      c.query<AutoRow>("INSERT INTO automatizaciones (org_id, nombre) VALUES (app_current_org(), $1) RETURNING id, org_id, nombre", [a.nombre]),
    ).catch((e) => comoCuota(e)); // trg_cuota_espacio → CuotaExcedida('espacios')
    const row = r.rows[0];
    if (!row) throw new Error("crearAutomatizacion: sin fila devuelta");
    return aAutomatizacion(row);
  }

  async desactivarAutomatizacion(id: string): Promise<void> {
    // Compensación de `construir`: libera el espacio del plan. El app tiene GRANT
    // UPDATE(activa); poner activa=false nunca choca con la cuota (el trigger la ignora).
    await conOrg(this.pool, this.orgId, (c) => c.query("UPDATE automatizaciones SET activa = false WHERE id = $1", [id]));
  }

  async crearVersion(v: Omit<Version, "id">): Promise<Version> {
    // tipo NULL = build INICIAL (no es un ajuste; los ajustes van por el servicio de
    // ciclo). `creada` la fija el trigger a now() (no se puede backdatear). Cobra una
    // generación al arrancar (cobrar_build) y respeta el kill-switch (trg_kill_build).
    const r = await conOrg(this.pool, this.orgId, (c) =>
      c.query<VerRow>(
        "INSERT INTO versiones (automatizacion_id, org_id, numero, estado, vista) VALUES ($1, app_current_org(), $2, $3, $4) RETURNING id, automatizacion_id, numero, estado, artefacto_key, vista, cma_session_id, creada",
        [v.automatizacionId, v.numero, v.estado, v.vista ? JSON.stringify(v.vista) : null],
      ),
    ).catch(traducirBuild);
    const row = r.rows[0];
    if (!row) throw new Error("crearVersion: sin fila devuelta");
    return aVersion(row);
  }

  async actualizarVersion(id: string, cambios: Partial<Version>): Promise<Version> {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    if (cambios.estado !== undefined) { vals.push(cambios.estado); sets.push(`estado = $${vals.length}`); }
    if ("artefactoKey" in cambios) { vals.push(cambios.artefactoKey ?? null); sets.push(`artefacto_key = $${vals.length}`); }
    if (sets.length === 0) { // nada que actualizar → devuelve el estado actual
      const actual = await this.obtenerVersion(id);
      if (!actual) throw new Error(`Versión no encontrada: ${id}`);
      return actual;
    }
    // El UPDATE de estado a ready/lista dispara trg_marcar_entrega (sella la entrega).
    const r = await conOrg(this.pool, this.orgId, (c) =>
      c.query<VerRow>(`UPDATE versiones SET ${sets.join(", ")} WHERE id = $1 RETURNING id, automatizacion_id, numero, estado, artefacto_key, vista, cma_session_id, creada`, vals),
    );
    const row = r.rows[0];
    if (!row) throw new Error(`Versión no encontrada: ${id}`); // RLS: ajena/inexistente
    return aVersion(row);
  }

  async fijarSesionCma(versionId: string, sessionId: string): Promise<void> {
    // cma_session_id NO está en el GRANT del app: se fija SOLO por este SD (write-once,
    // org-scoped, solo 'building'). Lanza SESION_CMA_NO_FIJABLE si ya tiene sesión / no es suya.
    await conOrg(this.pool, this.orgId, (c) => c.query("SELECT app_fijar_sesion_cma($1, $2)", [versionId, sessionId]));
  }

  async crearEjecucion(e: Omit<Ejecucion, "id">): Promise<Ejecucion> {
    // Reserva del run: dispara trg_kill_run ANTES de correr el código de IA (el freno
    // de ejecuciones muerde aquí, no post-hoc).
    const r = await conOrg(this.pool, this.orgId, (c) =>
      c.query<EjecRow>(
        "INSERT INTO ejecuciones (version_id, org_id, estado, ms, costo_usd) VALUES ($1, app_current_org(), $2, $3, $4) RETURNING id, version_id, estado, ms, costo_usd, resultado_key, creada",
        [e.versionId, e.estado, e.ms, e.costoUsd],
      ),
    ).catch(traducirBuild); // trg_kill_run (SERVICIO_SUSPENDIDO) + cobrar_ejecucion (CUOTA_EXCEDIDA)
    const row = r.rows[0];
    if (!row) throw new Error("crearEjecucion: sin fila devuelta");
    return aEjecucion(row);
  }

  async actualizarEjecucion(id: string, cambios: Partial<Ejecucion>): Promise<Ejecucion> {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    if (cambios.estado !== undefined) { vals.push(cambios.estado); sets.push(`estado = $${vals.length}`); }
    if (cambios.ms !== undefined) { vals.push(cambios.ms); sets.push(`ms = $${vals.length}`); }
    if (cambios.costoUsd !== undefined) { vals.push(cambios.costoUsd); sets.push(`costo_usd = $${vals.length}`); }
    if (cambios.resultadoKey !== undefined) { vals.push(cambios.resultadoKey); sets.push(`resultado_key = $${vals.length}`); }
    if (sets.length === 0) throw new Error("actualizarEjecucion: sin cambios");
    const r = await conOrg(this.pool, this.orgId, (c) =>
      c.query<EjecRow>(`UPDATE ejecuciones SET ${sets.join(", ")} WHERE id = $1 RETURNING id, version_id, estado, ms, costo_usd, resultado_key, creada`, vals),
    );
    const row = r.rows[0];
    if (!row) throw new Error(`Ejecución no encontrada: ${id}`);
    return aEjecucion(row);
  }

  async obtenerVersion(id: string): Promise<Version | undefined> {
    const r = await conOrg(this.pool, this.orgId, (c) =>
      c.query<VerRow>("SELECT id, automatizacion_id, numero, estado, artefacto_key, vista, cma_session_id, creada FROM versiones WHERE id = $1", [id]),
    );
    const row = r.rows[0];
    return row ? aVersion(row) : undefined;
  }
}
