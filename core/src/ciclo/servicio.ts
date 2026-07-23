import { type PoolClient } from "pg";
import { type Ciclo, type CicloEstado, type ResultadoRegresion, type TipoAjuste, ajustesRestantes, clasificar, puedeAjustar, trasAjuste } from "./estados.ts";
import { consumirGeneracion } from "../billing/cuota.ts";

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
}

function fila1<T>(r: { rows: T[] }): T | undefined {
  return r.rows[0];
}

const aEstado = (c: Ciclo): EstadoCiclo => ({
  estado: c.estado,
  ajustesUsados: c.ajustesUsados,
  ajustesRestantes: c.estado === "frozen" ? 0 : ajustesRestantes(c),
});

/** El ciclo actual (para la UI: "● ● ○  2 de 3"). frozen → 0 restantes. */
export async function estadoDelCiclo(c: PoolClient, autoId: string): Promise<EstadoCiclo> {
  const r = await c.query<{ ciclo_estado: CicloEstado; ajustes_usados: number }>(
    "SELECT ciclo_estado, ajustes_usados FROM automatizaciones WHERE id = $1",
    [autoId],
  );
  const f = fila1(r);
  if (!f) throw new AutomatizacionNoDisponible();
  return aEstado({ estado: f.ciclo_estado, ajustesUsados: f.ajustes_usados });
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
  const r = await c.query<{ ciclo_estado: CicloEstado; ajustes_usados: number; org_id: string }>(
    "SELECT ciclo_estado, ajustes_usados, org_id FROM automatizaciones WHERE id = $1 AND activa FOR UPDATE",
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
  const ver = await c.query<{ id: string }>(
    "INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1, $2, $3, 'building') RETURNING id",
    [autoId, f.org_id, numero],
  );
  return { tipo, versionId: ver.rows[0]!.id, numero, ciclo: aEstado(ciclo) };
}

/**
 * Confirma un ajuste cuyo build llegó a `ready`. Idempotente: solo consume si la versión
 * transiciona building→lista (un webhook duplicado no doble-consume). Un CAMBIO consume el
 * ajuste (y una generación del mes) y quizá congela; una REPARACIÓN no consume.
 */
export async function confirmarAjuste(c: PoolClient, autoId: string, versionId: string, tipo: TipoAjuste, periodo: string): Promise<EstadoCiclo> {
  const upd = await c.query(
    "UPDATE versiones SET estado = 'lista' WHERE id = $1 AND automatizacion_id = $2 AND estado = 'building' RETURNING id",
    [versionId, autoId],
  );
  if ((upd.rowCount ?? 0) === 0) return estadoDelCiclo(c, autoId); // ya confirmada/fallida/ajena → no re-consumir

  if (tipo === "cambio") {
    const r = await c.query<{ ciclo_estado: CicloEstado; ajustes_usados: number }>(
      "SELECT ciclo_estado, ajustes_usados FROM automatizaciones WHERE id = $1 FOR UPDATE",
      [autoId],
    );
    const f = fila1(r);
    if (!f) throw new AutomatizacionNoDisponible();
    const nuevo = trasAjuste({ estado: f.ciclo_estado, ajustesUsados: f.ajustes_usados }, "cambio");
    await c.query("UPDATE automatizaciones SET ciclo_estado = $2, ajustes_usados = $3 WHERE id = $1", [autoId, nuevo.estado, nuevo.ajustesUsados]);
    await consumirGeneracion(c, periodo); // docs/06 §4: un cambio a ready consume una generación del mes
    return aEstado(nuevo);
  }
  return estadoDelCiclo(c, autoId); // reparación: gratis
}

/** Build fallido: marca la versión 'failed' (libera el "en vuelo"). No consume nada. */
export async function fallarAjuste(c: PoolClient, autoId: string, versionId: string): Promise<void> {
  await c.query("UPDATE versiones SET estado = 'failed' WHERE id = $1 AND automatizacion_id = $2 AND estado = 'building'", [versionId, autoId]);
}

/** Congelado voluntario ("esta ya quedó", docs/08 §3). Idempotente. */
export async function congelar(c: PoolClient, autoId: string): Promise<EstadoCiclo> {
  const r = await c.query<{ ajustes_usados: number }>(
    "UPDATE automatizaciones SET ciclo_estado = 'frozen' WHERE id = $1 RETURNING ajustes_usados",
    [autoId],
  );
  const f = fila1(r);
  if (!f) throw new AutomatizacionNoDisponible();
  return aEstado({ estado: "frozen", ajustesUsados: f.ajustes_usados });
}
