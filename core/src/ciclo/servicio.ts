import { type Pool, type PoolClient } from "pg";
import { type EstadoBuild } from "../types.ts";
import { type Ciclo, type CicloEstado, type ResultadoRegresion, type TipoAjuste, ajustesRestantes, clasificar, puedeAjustar } from "./estados.ts";
import { comoCuota } from "../billing/cuota.ts";
import { comoSuspension } from "../ops/killswitch.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Aplicación del ciclo de vida en Postgres (docs/08). Patrón RESERVA→CONFIRMA:
//   iniciarAjuste  → deriva el tipo de la REGRESIÓN (no del llamador), valida guardas
//                    (activa, sin build en curso, cambio permitido) y crea la versión
//                    'building'. NO consume nada todavía.
//   confirmarAjuste→ cuando el build llega a `ready`: un CAMBIO consume el ajuste (y una
//                    generación del mes, M3) y quizá congela; una REPARACIÓN no consume.
//   fallarAjuste   → build fallido: nada se consume (docs/06 §4: "los fallidos no cuentan").
//
// Corre por conOrg (RLS acota a la org, rol no-dueño). El cerrojo de fila (FOR UPDATE)
// serializa peticiones concurrentes; el "un build en vuelo por automatización" evita el
// spam de builds y el oversell.
// ─────────────────────────────────────────────────────────────────────────────

export class AjusteNoPermitido extends Error {
  // 'en_revision' = circuit breaker de reparaciones ENGANCHADO: la automatización superó
  //   su tasa de reparaciones y quedó latcheada hasta que ops la rearme (docs/08 §2). NO
  //   es un cobro: es un detector de avería. Copy honesto para la UI mientras el push a
  //   ops no esté cableado: "pausamos el auto-arreglo de esta automatización" — NO "un
  //   humano ya está revisando" (nadie lo está hasta que se cablee la alerta).
  // 'suscripcion' = la org no tiene subscription activa (morosa/cancelada): no dispara
  //   builds hasta regularizar el pago (simétrico con los cambios).
  constructor(public readonly motivo: "frozen" | "ajustes_agotados" | "en_revision" | "suscripcion") {
    super(`Ajuste no permitido: ${motivo}`);
    this.name = "AjusteNoPermitido";
  }
}
export class AjusteEnCurso extends Error {
  constructor() { super("Ya hay un ajuste en construcción para esta automatización."); this.name = "AjusteEnCurso"; }
}
export class AutomatizacionNoDisponible extends Error {
  constructor() { super("La automatización no existe en esta org o está inactiva (solo lectura)."); this.name = "AutomatizacionNoDisponible"; }
}

export interface EstadoCiclo {
  estado: CicloEstado;
  ajustesUsados: number;
  ajustesRestantes: number; // 0 si frozen: ningún cambio es posible (la UI no debe prometer disponibilidad)
  // Ventana de 30 días desde la ENTREGA (docs/06 §4): dentro de ella los cambios no
  // gastan ajuste. La UI dice "gratis hasta el <fecha>" en vez de "2 de 3".
  ventanaGratis: boolean;
  ventanaHasta: string | null; // ISO; null si aún no se entrega
  // Circuit breaker de reparaciones enganchado (docs/08 §2): la UI muestra "pausamos el
  // auto-arreglo" en vez de ofrecer más reparaciones.
  enRevision: boolean;
}

function fila1<T>(r: { rows: T[] }): T | undefined {
  return r.rows[0];
}

// ── Reaper de builds huérfanos ───────────────────────────────────────────────
const REAP_PISO_MIN = 30;     // NUNCA reaper-ear builds más frescos que esto (protege el "en vuelo")
const REAP_DEFAULT_MIN = 360; // 6h: muy por encima del build de CMA más lento (~10 min + cola/reintentos)
/** Umbral de "build muerto" saneado: entero ≥ piso, o el default. Clamp defensivo — nunca
 *  reaper-ea builds frescos (staleMin ≤ 0 o no-entero → default). NO alimentar desde un request. */
function minStale(v: number | undefined): number {
  const n = Math.trunc(Number(v ?? REAP_DEFAULT_MIN));
  return Number.isFinite(n) && n >= REAP_PISO_MIN ? n : REAP_DEFAULT_MIN;
}

const aEstado = (c: Ciclo, gratis = false, hasta: string | null = null, enRevision = false): EstadoCiclo => ({
  estado: c.estado,
  ajustesUsados: c.ajustesUsados,
  ajustesRestantes: c.estado === "frozen" ? 0 : ajustesRestantes(c),
  ventanaGratis: gratis,
  ventanaHasta: hasta,
  enRevision,
});

/** Traduce el 'AJUSTE_NO_PERMITIDO:<motivo>' de la BD; re-lanza cualquier otro error. */
function comoAjuste(e: unknown): never {
  const msg = (e as { message?: string })?.message ?? "";
  const m = /AJUSTE_NO_PERMITIDO:(frozen|ajustes_agotados|en_revision|suscripcion|build_en_vuelo|no_existe)/.exec(msg);
  if (m?.[1] === "no_existe") throw new AutomatizacionNoDisponible();
  if (m?.[1] === "build_en_vuelo") throw new AjusteEnCurso(); // no se puede congelar con un build en vuelo
  if (m) throw new AjusteNoPermitido(m[1] as "frozen" | "ajustes_agotados" | "en_revision" | "suscripcion");
  throw e;
}

interface FilaCiclo {
  ciclo_estado: CicloEstado;
  ajustes_usados: number;
  gratis: boolean;
  hasta: string | null;
  en_revision: boolean;
}
const SELECT_CICLO = `SELECT ciclo_estado, ajustes_usados, en_ventana_gratis(id) AS gratis,
    to_char(entregada + interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SSOF') AS hasta,
    (en_revision IS NOT NULL) AS en_revision
  FROM automatizaciones WHERE id = $1`;

/** El ciclo actual (para la UI: "● ● ○  2 de 3", o "ajustes gratis hasta el X").
 *  frozen → 0 restantes. */
export async function estadoDelCiclo(c: PoolClient, autoId: string): Promise<EstadoCiclo> {
  const r = await c.query<FilaCiclo>(SELECT_CICLO, [autoId]);
  const f = fila1(r);
  if (!f) throw new AutomatizacionNoDisponible();
  return aEstado({ estado: f.ciclo_estado, ajustesUsados: f.ajustes_usados }, f.gratis, f.hasta, f.en_revision);
}

export interface Iniciado {
  tipo: TipoAjuste;
  versionId: string;
  numero: number;
  ciclo: EstadoCiclo; // sin cambios aún (se consume al confirmar)
}

/**
 * Inicia un ajuste. El TIPO se DERIVA de la regresión (clasificar), nunca lo elige el
 * llamador. Guarda: automatización activa, sin otra versión 'building', y —para un
 * cambio— ready con ajustes disponibles. Crea la versión 'building' sin consumir.
 */
export async function iniciarAjuste(c: PoolClient, autoId: string, regresion: ResultadoRegresion, opts?: { staleMin?: number }): Promise<Iniciado> {
  // Solo automatizaciones ACTIVAS y de ESTA org (RLS). activa=false = solo lectura (docs/06 §9).
  const r = await c.query<FilaCiclo & { org_id: string }>(
    `SELECT ciclo_estado, ajustes_usados, org_id, en_ventana_gratis(id) AS gratis,
            to_char(entregada + interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SSOF') AS hasta,
            (en_revision IS NOT NULL) AS en_revision
       FROM automatizaciones WHERE id = $1 AND activa FOR UPDATE`,
    [autoId],
  );
  const f = fila1(r);
  if (!f) throw new AutomatizacionNoDisponible();

  // AUTO-SANACIÓN (reaper): un build 'building' AÑEJO quedó huérfano (el proceso murió o
  // el webhook de fin de build nunca llegó). Sin esto, la guarda "un build en vuelo" de
  // abajo rechazaría TODO ajuste posterior para siempre (AjusteEnCurso) → automatización
  // ladrillada. Se marca 'failed' (la generación ya se cobró al arrancar: no se reembolsa,
  // docs/06 §4). Corre bajo el FOR UPDATE de arriba, así que serializa con otros iniciar.
  const staleMin = minStale(opts?.staleMin);
  await c.query(
    "UPDATE versiones SET estado = 'failed' WHERE automatizacion_id = $1 AND estado = 'building' AND creada < now() - ($2 || ' minutes')::interval",
    [autoId, staleMin],
  );

  // Un solo build en vuelo RECIENTE por automatización (anti-spam + evita versiones paralelas).
  const enCurso = await c.query("SELECT 1 FROM versiones WHERE automatizacion_id = $1 AND estado = 'building'", [autoId]);
  if ((enCurso.rowCount ?? 0) > 0) throw new AjusteEnCurso();

  const ciclo: Ciclo = { estado: f.ciclo_estado, ajustesUsados: f.ajustes_usados };
  const tipo = clasificar(regresion);
  const d = puedeAjustar(ciclo, tipo);
  if (!d.permitido) throw new AjusteNoPermitido(d.motivo);

  const num = await c.query<{ n: number }>(
    "SELECT coalesce(max(numero), 0) + 1 AS n FROM versiones WHERE automatizacion_id = $1",
    [autoId],
  );
  const numero = num.rows[0]?.n ?? 1;
  const ver = await c
    .query<{ id: string }>(
      // El TIPO derivado se PERSISTE aquí: al confirmar, la BD lo lee de la fila en vez
      // de creerle al llamador (antes bastaba decir 'reparacion' para no pagar nada).
      // Este INSERT es además donde se cobra la generación (trigger trg_presupuesto_build):
      // el build no arranca sin presupuesto, ni si la suscripción no está activa.
      "INSERT INTO versiones (automatizacion_id, org_id, numero, estado, tipo) VALUES ($1, $2, $3, 'building', $4) RETURNING id",
      [autoId, f.org_id, numero, tipo],
    )
    .catch((e) => comoCuota(e)) // CUOTA_EXCEDIDA (generación al arrancar) → CuotaExcedida
    .catch((e) => comoAjuste(e)) // circuit breaker de reparaciones → AjusteNoPermitido('en_revision')
    .catch((e) => comoSuspension(e)); // kill-switch de builds / org suspendida → ServicioSuspendido
  return { tipo, versionId: ver.rows[0]!.id, numero, ciclo: aEstado(ciclo, f.gratis, f.hasta, f.en_revision) };
}

/**
 * Confirma un ajuste cuyo build llegó a `ready`. Idempotente: solo consume si la versión
 * transiciona building→lista (un webhook duplicado no doble-consume). El TIPO ya no se
 * recibe: la BD lo lee de la versión (lo persistió iniciarAjuste derivándolo de la
 * regresión), así el llamador no puede declarar 'reparacion' y no pagar. La generación
 * tampoco se consume aquí — se cobró al ARRANCAR el build.
 *
 * ENTREGA GARANTIZADA (docs/08): el build ya llegó a `ready` y ya se pagó (la
 * generación se cobró al ARRANCAR). Así que la versión se ENTREGA (building→lista) pase
 * lo que pase con el conteo del ciclo. El consumo del ajuste va tras un SAVEPOINT: si
 * falla (p.ej. la automatización quedó frozen mientras el build estaba en vuelo), NO se
 * tira la transacción — eso devolvería la versión a 'building' y la guarda anti-spam de
 * iniciarAjuste ladrillaría la automatización PARA SIEMPRE (incluidas las reparaciones,
 * que docs/08 §2 promete incondicionales). Se entrega igual y se registra el incidente;
 * el cliente siempre recibe el build que pagó. Idempotente: un webhook duplicado no
 * re-consume (el UPDATE building→lista solo pega una vez).
 */
export async function confirmarAjuste(c: PoolClient, autoId: string, versionId: string): Promise<EstadoCiclo> {
  const upd = await c.query(
    "UPDATE versiones SET estado = 'lista' WHERE id = $1 AND automatizacion_id = $2 AND estado = 'building' RETURNING id",
    [versionId, autoId],
  );
  if ((upd.rowCount ?? 0) === 0) {
    // 0 filas = ya confirmada (webhook duplicado, benigno), ajena, o 'failed'. Si está
    // 'failed' pero el caller creía que el build COMPLETÓ, es un entregable PAGADO perdido:
    // el reaper la marcó por lenta, o el build falló y llegó tarde. No se traga en silencio.
    const est = await c.query<{ estado: EstadoBuild }>("SELECT estado FROM versiones WHERE id = $1 AND automatizacion_id = $2", [versionId, autoId]);
    if (est.rows[0]?.estado === "failed") {
      console.error(`[ciclo] confirmarAjuste sobre versión ${versionId} en 'failed' (¿reaper-eada por lenta?): build pagado NO entregado — reconciliar/re-entregar.`);
    }
    return estadoDelCiclo(c, autoId);
  }
  // (el paso a 'lista' de la PRIMERA versión sella `entregada` vía trigger: ahí
  //  arranca la ventana de 30 días.)

  // El contador lo lleva la BD y decide POR EL TIPO PERSISTIDO en la versión: una
  // reparación no consume; un cambio sí, salvo dentro de la ventana de 30 días. El app
  // ya no puede escribir ajustes_usados NI elegir el tipo al confirmar. El SAVEPOINT hace
  // que un fallo aquí NO revierta la entrega ya hecha (la versión queda 'lista').
  await c.query("SAVEPOINT tras_entrega");
  try {
    await c.query("SELECT estado, usados, gratis, tipo FROM app_consumir_ajuste($1)", [versionId]);
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? "";
    // Solo se traga-y-entrega cuando el conteo no procede por REGLA DE NEGOCIO (la
    // automatización quedó frozen a mitad de vuelo, etc.): reintentar no ayudaría y el
    // build ya se pagó. Un error TÉCNICO (deadlock/serialization/lock/desconexión) se
    // RE-LANZA: conOrg hace rollback total y el webhook reintenta confirmarAjuste limpio
    // (re-entrega desde 'building' y esta vez SÍ cuenta) — sin brick (el reintento
    // re-entrega) y sin perder el conteo de un cambio de pago en silencio.
    if (!/AJUSTE_NO_PERMITIDO:(frozen|ajustes_agotados|no_existe)/.test(msg)) throw e;
    await c.query("ROLLBACK TO SAVEPOINT tras_entrega"); // preserva building→lista
    // La versión queda entregada; el ciclo no avanza. En producción esto es una alerta
    // durable a ops (build entregado sin contabilizar); aquí, log del incidente.
    console.error(`[ciclo] versión ${versionId} entregada sin contar el ajuste (${msg})`);
  }
  return estadoDelCiclo(c, autoId);
}

/** Build fallido: marca la versión 'failed' (libera el "en vuelo"). No consume nada. */
export async function fallarAjuste(c: PoolClient, autoId: string, versionId: string): Promise<void> {
  await c.query("UPDATE versiones SET estado = 'failed' WHERE id = $1 AND automatizacion_id = $2 AND estado = 'building'", [versionId, autoId]);
}

/** Congelado voluntario ("esta ya quedó", docs/08 §3). Idempotente. Va por función
 *  de la BD: el app perdió el UPDATE sobre ciclo_estado (si no, podría des-congelarse). */
export async function congelar(c: PoolClient, autoId: string): Promise<EstadoCiclo> {
  await c.query("SELECT estado, usados FROM app_congelar($1)", [autoId]).catch((e) => comoAjuste(e));
  return estadoDelCiclo(c, autoId);
}

export interface EnRevision {
  autoId: string;
  orgId: string;
  desde: string; // cuándo enganchó el latch (ISO)
}
/**
 * Ops (dueño): automatizaciones con el circuit breaker ENGANCHADO (latch), esperando
 * revisión humana (el "escalar" de la decisión). Lee el latch persistente en_revision —
 * NO recomputa un conteo mensual, así que sigue apareciendo aunque cambie el mes. Corre
 * con la conexión de DUEÑO (ve todas las orgs). Pull-based; el push (alerta) se cablea
 * con el resto de servicios — hasta entonces el copy de la UI no debe afirmar que un
 * humano ya está revisando (ver AjusteNoPermitido).
 */
export async function automatizacionesEnRevision(owner: Pool): Promise<EnRevision[]> {
  const r = await owner.query<{ auto_id: string; org_id: string; desde: string }>(
    `SELECT id AS auto_id, org_id, en_revision::text AS desde
       FROM automatizaciones WHERE en_revision IS NOT NULL ORDER BY en_revision`,
  );
  return r.rows.map((x) => ({ autoId: x.auto_id, orgId: x.org_id, desde: x.desde }));
}

/**
 * Ops (dueño) REARMA el breaker tras revisar/arreglar: quita el latch. La automatización
 * vuelve a aceptar reparaciones; si sigue rota (regresión sigue fallando) volverá a
 * enganchar rápido — señal correcta. El app no puede rearmarlo (REVOKE UPDATE sobre
 * automatizaciones; en_revision no está en el GRANT de columnas).
 */
export async function limpiarRevision(owner: Pool, autoId: string): Promise<void> {
  await owner.query("UPDATE automatizaciones SET en_revision = NULL WHERE id = $1", [autoId]);
}

/**
 * Ops/cron (dueño): barre TODOS los builds 'building' AÑEJOS (más viejos que `minutos`)
 * → 'failed', en todas las orgs. Backstop proactivo del reaper: iniciarAjuste ya
 * auto-sana la automatización que el cliente reintenta, pero esto limpia las que nadie
 * reintenta (para que no queden 'building' colgados y para observabilidad). El primary
 * fix en producción es cablear fallarAjuste al webhook de fallo de CMA; esto es la red.
 * Devuelve cuántos reaper-eó.
 */
export async function reaparBuildsColgados(owner: Pool, minutos?: number): Promise<number> {
  const min = minStale(minutos); // clamp: minutos ≤ 0 barrería TODO 'building' de todas las orgs
  const r = await owner.query(
    "UPDATE versiones SET estado = 'failed' WHERE estado = 'building' AND creada < now() - ($1 || ' minutes')::interval RETURNING id",
    [min],
  );
  return r.rowCount ?? 0;
}
