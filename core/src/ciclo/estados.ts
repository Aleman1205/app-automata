// ─────────────────────────────────────────────────────────────────────────────
// El ciclo de vida de una automatización (docs/08): se construye una vez, se ajusta
// hasta 3 veces, y se congela. Lógica PURA (sin DB): la clasificación cambio/
// reparación, las guardas, y las transiciones. El servicio (servicio.ts) la aplica
// atómicamente en Postgres.
// ─────────────────────────────────────────────────────────────────────────────

export type CicloEstado = "ready" | "frozen";
export type TipoAjuste = "cambio" | "reparacion";

export const MAX_AJUSTES = 3; // 3 ajustes incluidos → 4 versiones máx (v1 + 3)

// Resultado de correr el ejemplo original contra la versión actual (lo produce
// Run+verifier, M0). `indeterminado` = no había ejemplo, no se pudo ejecutar, timeout.
export type ResultadoRegresion = "pasa" | "falla" | "indeterminado";

/**
 * La regla DETERMINISTA de docs/08 §2 (se decide con datos, no con criterio).
 *   · el ejemplo original FALLA de verdad → algo se rompió → REPARACIÓN (gratis)
 *   · el ejemplo original PASA             → el cliente quiere otra cosa → CAMBIO (cobra)
 *   · INDETERMINADO (ausente/no ejecutable) → CAMBIO (fail-safe: cobra). Si no fuera así,
 *     "ensuciar" el ejemplo o no dejar ninguno volvería cualquier cambio gratis.
 */
export function clasificar(regresion: ResultadoRegresion): TipoAjuste {
  return regresion === "falla" ? "reparacion" : "cambio";
}

export interface Ciclo {
  estado: CicloEstado;
  ajustesUsados: number;
}

export function ajustesRestantes(c: Ciclo): number {
  return Math.max(0, MAX_AJUSTES - c.ajustesUsados);
}

export type Decision = { permitido: true } | { permitido: false; motivo: "frozen" | "ajustes_agotados" };

/**
 * ¿Se puede aplicar este ajuste? Una REPARACIÓN siempre se puede (gratis, ilimitada,
 * incluso sobre una automatización `frozen` — mantenerla viva es obligación, no favor,
 * docs/08 §2). Un CAMBIO exige estar `ready` con ajustes disponibles.
 */
export function puedeAjustar(c: Ciclo, tipo: TipoAjuste): Decision {
  if (tipo === "reparacion") return { permitido: true };
  if (c.estado === "frozen") return { permitido: false, motivo: "frozen" };
  if (ajustesRestantes(c) <= 0) return { permitido: false, motivo: "ajustes_agotados" };
  return { permitido: true };
}

/**
 * El ciclo tras aplicar un ajuste PERMITIDO. Un CAMBIO consume uno de los 3 y, al
 * llegar al tope, congela (v4 es el último). Una REPARACIÓN no consume ni cambia el
 * estado del ciclo. Presupone puedeAjustar(...).permitido === true.
 */
export function trasAjuste(c: Ciclo, tipo: TipoAjuste): Ciclo {
  if (tipo === "reparacion") return c;
  const usados = c.ajustesUsados + 1;
  return { estado: usados >= MAX_AJUSTES ? "frozen" : "ready", ajustesUsados: usados };
}

/** Congelado voluntario ("esta ya quedó", docs/08 §3). Idempotente. */
export function congelar(c: Ciclo): Ciclo {
  return { ...c, estado: "frozen" };
}
