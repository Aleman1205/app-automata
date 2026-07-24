import { type PoolClient } from "pg";
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
  constructor(public readonly motivo: "frozen" | "ajustes_agotados") {
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
}

function fila1<T>(r: { rows: T[] }): T | undefined {
  return r.rows[0];
}

const aEstado = (c: Ciclo, gratis = false, hasta: string | null = null): EstadoCiclo => ({
  estado: c.estado,
  ajustesUsados: c.ajustesUsados,
  ajustesRestantes: c.estado === "frozen" ? 0 : ajustesRestantes(c),
  ventanaGratis: gratis,
  ventanaHasta: hasta,
});

/** Traduce el 'AJUSTE_NO_PERMITIDO:<motivo>' de la BD; re-lanza cualquier otro error. */
function comoAjuste(e: unknown): never {
  const msg = (e as { message?: string })?.message ?? "";
  const m = /AJUSTE_NO_PERMITIDO:(frozen|ajustes_agotados|no_existe)/.exec(msg);
  if (m?.[1] === "no_existe") throw new AutomatizacionNoDisponible();
  if (m) throw new AjusteNoPermitido(m[1] as "frozen" | "ajustes_agotados");
  throw e;
}

interface FilaCiclo {
  ciclo_estado: CicloEstado;
  ajustes_usados: number;
  gratis: boolean;
  hasta: string | null;
}
const SELECT_CICLO = `SELECT ciclo_estado, ajustes_usados, en_ventana_gratis(id) AS gratis,
    to_char(entregada + interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SSOF') AS hasta
  FROM automatizaciones WHERE id = $1`;

/** El ciclo actual (para la UI: "● ● ○  2 de 3", o "ajustes gratis hasta el X").
 *  frozen → 0 restantes. */
export async function estadoDelCiclo(c: PoolClient, autoId: string): Promise<EstadoCiclo> {
  const r = await c.query<FilaCiclo>(SELECT_CICLO, [autoId]);
  const f = fila1(r);
  if (!f) throw new AutomatizacionNoDisponible();
  return aEstado({ estado: f.ciclo_estado, ajustesUsados: f.ajustes_usados }, f.gratis, f.hasta);
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
export async function iniciarAjuste(c: PoolClient, autoId: string, regresion: ResultadoRegresion): Promise<Iniciado> {
  // Solo automatizaciones ACTIVAS y de ESTA org (RLS). activa=false = solo lectura (docs/06 §9).
  const r = await c.query<FilaCiclo & { org_id: string }>(
    `SELECT ciclo_estado, ajustes_usados, org_id, en_ventana_gratis(id) AS gratis,
            to_char(entregada + interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SSOF') AS hasta
       FROM automatizaciones WHERE id = $1 AND activa FOR UPDATE`,
    [autoId],
  );
  const f = fila1(r);
  if (!f) throw new AutomatizacionNoDisponible();

  // Un solo build en vuelo por automatización (anti-spam + evita versiones paralelas).
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
    .catch((e) => comoCuota(e))
    .catch((e) => comoSuspension(e)); // kill-switch de builds / org suspendida → ServicioSuspendido
  return { tipo, versionId: ver.rows[0]!.id, numero, ciclo: aEstado(ciclo, f.gratis, f.hasta) };
}

/**
 * Confirma un ajuste cuyo build llegó a `ready`. Idempotente: solo consume si la versión
 * transiciona building→lista (un webhook duplicado no doble-consume). El TIPO ya no se
 * recibe: la BD lo lee de la versión (lo persistió iniciarAjuste derivándolo de la
 * regresión), así el llamador no puede declarar 'reparacion' y no pagar. La generación
 * tampoco se consume aquí — se cobró al ARRANCAR el build.
 *
 * DECISIÓN de kill-switch (docs/14 §3): el freno de builds detiene builds NUEVOS
 * (iniciarAjuste → trg_kill_build). Un build YA EN VUELO (versión 'building' creada
 * antes de congelar, con su sesión CMA abierta) se DEJA terminar: (a) el costo de CMA
 * ya se incurrió, (b) un trigger no puede matar la sesión remota, (c) bloquear el
 * UPDATE building→lista solo dejaría la versión huérfana. Aceptado. Para cortar de
 * verdad a un tenant abusivo en incidente se usa la suspensión por-org, que sí frena
 * sus builds/runs nuevos.
 */
export async function confirmarAjuste(c: PoolClient, autoId: string, versionId: string): Promise<EstadoCiclo> {
  const upd = await c.query(
    "UPDATE versiones SET estado = 'lista' WHERE id = $1 AND automatizacion_id = $2 AND estado = 'building' RETURNING id",
    [versionId, autoId],
  );
  if ((upd.rowCount ?? 0) === 0) return estadoDelCiclo(c, autoId); // ya confirmada/fallida/ajena → no re-consumir
  // (el paso a 'lista' de la PRIMERA versión sella `entregada` vía trigger: ahí
  //  arranca la ventana de 30 días.)

  // El contador lo lleva la BD y decide POR EL TIPO PERSISTIDO en la versión: una
  // reparación no consume; un cambio sí, salvo dentro de la ventana de 30 días. El
  // app ya no puede escribir ajustes_usados NI elegir el tipo al confirmar.
  // (La generación NO se consume aquí: se cobró al ARRANCAR el build — docs/10 §8,
  //  "tope de builds INICIADOS" — para que el dinero no se gaste sin presupuesto.)
  await c
    .query<{ estado: CicloEstado; usados: number; gratis: boolean; tipo: string }>(
      "SELECT estado, usados, gratis, tipo FROM app_consumir_ajuste($1)",
      [versionId],
    )
    .catch((e) => comoAjuste(e));
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
