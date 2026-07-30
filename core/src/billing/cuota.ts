import { type PoolClient } from "pg";
import { type Rol } from "../auth/roles.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement de cuotas (M3, docs/06 + docs/11 §8). Capa DELGADA sobre la BD: el
// tope real lo imponen los triggers/función de db/schema.sql (los límites viven en
// la tabla `planes`), NO este código. Así el rol de app no puede saltárselo aunque
// el código de la app tenga un bug o una inyección — corrección de la revisión
// adversarial de M3 (RLS aísla entre orgs, no da integridad intra-org).
//
// Todo corre dentro de conOrg(org): la org sale de app.current_org (servidor), no
// de un parámetro del cliente. Estas funciones traducen los errores de la BD a
// tipos accionables (CuotaExcedida) o los propagan (fail-closed).
// ─────────────────────────────────────────────────────────────────────────────

export type Recurso = "espacios" | "generaciones" | "ejecuciones" | "usuarios";

export class CuotaExcedida extends Error {
  constructor(
    public readonly recurso: Recurso,
    public readonly limite: number,
    public readonly plan: string,
  ) {
    super(`Cuota de '${recurso}' agotada en el plan '${plan}' (límite ${limite}). Sube de plan para más.`);
    this.name = "CuotaExcedida";
  }
}

/** El mes UTC actual como 'YYYY-MM'. Se pasa explícito a los consumidores para que
 *  los tests sean deterministas; este helper es la conveniencia para producción.
 *  NOTA (revisión M3): mes-calendario UTC, no alineado al ciclo de facturación
 *  (subscriptions.periodo_fin) ni a la zona MX — pendiente de M3-billing. */
export function periodoActual(ahora: Date = new Date()): string {
  const y = ahora.getUTCFullYear();
  const m = String(ahora.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function fila1<T>(r: { rows: T[] }): T {
  const f = r.rows[0];
  if (f === undefined) throw new Error("La consulta no devolvió filas (se esperaba una).");
  return f;
}

/** Traduce el 'CUOTA_EXCEDIDA:<recurso>:<limite>:<plan>' que lanza la BD a
 *  CuotaExcedida; re-lanza cualquier otro error (p.ej. 'sin subscription',
 *  'permission denied', estado ≠ activa) para que falle cerrado. */
export function comoCuota(e: unknown): never {
  const msg = (e as { message?: string })?.message ?? "";
  const m = /CUOTA_EXCEDIDA:(espacios|generaciones|ejecuciones|usuarios):(\d+):(\w+)/.exec(msg);
  if (m) throw new CuotaExcedida(m[1] as Recurso, Number(m[2]), m[3] as string);
  throw e;
}

/**
 * Crea una automatización activa. El trigger de la BD hace cumplir el tope de
 * espacios (con advisory lock por-org: TOCTOU-safe). Devuelve el id nuevo, o lanza
 * CuotaExcedida('espacios') si el plan está lleno. Reservar y crear son el MISMO
 * INSERT → imposible partir el check de la escritura.
 */
export async function crearAutomatizacion(c: PoolClient, nombre: string): Promise<string> {
  try {
    const r = await c.query<{ id: string }>(
      "INSERT INTO automatizaciones (org_id, nombre) VALUES (app_current_org(), $1) RETURNING id",
      [nombre],
    );
    return fila1(r).id;
  } catch (e) {
    comoCuota(e);
  }
}

/**
 * Invita a alguien por CORREO: deja una invitación pendiente que se vuelve membresía cuando esa
 * persona se registra (app_aceptar_invitaciones, desde el alta). No se puede insertar la membresía
 * aquí porque el user_id real lo asigna Clerk al registrarse — inventarlo (p.ej. del correo) dejaba
 * una fila huérfana que nunca casaba con el JWT.
 * El trigger de la BD hace cumplir el tope de usuarios del plan contando miembros + pendientes.
 * Lanza CuotaExcedida('usuarios') si está lleno.
 */
export async function invitarPorCorreo(c: PoolClient, correo: string, rol: Rol): Promise<void> {
  try {
    await c.query(
      "INSERT INTO invitaciones (org_id, correo, rol) VALUES (app_current_org(), $1, $2) ON CONFLICT (org_id, correo) DO UPDATE SET rol = EXCLUDED.rol",
      [correo, rol],
    );
  } catch (e) {
    comoCuota(e);
  }
}

/** Consume una unidad de un contador de flujo del mes vía app_consumir() (la BD
 *  lee el límite de `planes` y exige subscription 'activa'). Devuelve el nuevo
 *  valor o lanza CuotaExcedida. */
async function consumir(c: PoolClient, periodo: string, recurso: "generaciones" | "ejecuciones"): Promise<number> {
  try {
    const r = await c.query<{ v: number }>("SELECT app_consumir($1, $2) AS v", [periodo, recurso]);
    return fila1(r).v;
  } catch (e) {
    comoCuota(e);
  }
}

// ⚠️ INTERNO / TEST — NO llamar en producción. El cobro de cuota es 100% de los TRIGGERS
// de la BD (cobrar_build al INSERT en versiones; cobrar_ejecucion al INSERT en ejecuciones),
// que son la fuente ÚNICA. Estos wrappers llaman app_consumir directamente y existen solo
// para EJERCER esa función en las pruebas (TOCTOU, reset mensual, morosa/cancelada). Llamarlos
// además del trigger sería DOBLE-COBRO.
/** [test] Consume una generación vía app_consumir directamente. */
export function consumirGeneracion(c: PoolClient, periodo: string): Promise<number> {
  return consumir(c, periodo, "generaciones");
}
/** [test] Consume una ejecución vía app_consumir directamente. */
export function consumirEjecucion(c: PoolClient, periodo: string): Promise<number> {
  return consumir(c, periodo, "ejecuciones");
}

/** ¿El plan de la org permite exportar el código fuente? Fail-closed: sin
 *  subscription o estado ≠ activa → false. */
export async function puedeExportar(c: PoolClient): Promise<boolean> {
  const r = await c.query<{ exportar: boolean; estado: string }>(
    `SELECT p.exportar_codigo AS exportar, s.estado
       FROM subscriptions s JOIN planes p ON p.plan = s.plan
      WHERE s.org_id = app_current_org()`,
  );
  const row = r.rows[0];
  if (!row || row.estado !== "activa") return false;
  return row.exportar;
}
