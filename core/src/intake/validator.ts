import type { IntakeSpec } from "./schema.ts";

// Validación programática del spec (docs/10 §4). Corre DESPUÉS del esquema del
// modelo, atrapa lo que el JSON Schema no expresa, y es determinista (sin modelo)
// — por eso es el corazón de la verificación gratis de M1.

export interface Validacion {
  ok: boolean;
  errores: string[];
}

export function validarSpec(spec: IntakeSpec): Validacion {
  const e: string[] = [];

  if (typeof spec.objetivo !== "string" || spec.objetivo.length < 20 || spec.objetivo.length > 500) {
    e.push(`objetivo debe ser 20–500 chars (es ${spec.objetivo?.length ?? 0}).`);
  }
  if (!Array.isArray(spec.entradas) || spec.entradas.length < 1) e.push("se requiere ≥ 1 entrada.");
  if (!Array.isArray(spec.salidas) || spec.salidas.length < 1) e.push("se requiere ≥ 1 salida.");

  if (!Array.isArray(spec.criterios_exito) || spec.criterios_exito.length < 2) {
    e.push("se requieren ≥ 2 criterios de éxito.");
  } else if (spec.criterios_exito.length > 10) {
    e.push("máximo 10 criterios de éxito.");
  }

  // Fidelidad bilingüe mínima: ambos lados no vacíos (la semántica la audita Haiku, §5).
  for (const [i, c] of (spec.criterios_exito ?? []).entries()) {
    if (!c.criterio?.trim() || !c.criterio_cliente?.trim()) {
      e.push(`criterio #${i + 1}: criterio y criterio_cliente no pueden estar vacíos.`);
    }
  }

  if (Array.isArray(spec.reglas) && spec.reglas.length > 15) e.push("máximo 15 reglas.");

  // Regla clave del §4: baja confianza obliga a declarar las ambigüedades.
  if (spec.confianza === "baja" && (!spec.ambiguedades_restantes || spec.ambiguedades_restantes.length === 0)) {
    e.push("confianza 'baja' exige ambiguedades_restantes no vacías.");
  }
  if (!["alta", "media", "baja"].includes(spec.confianza)) e.push("confianza inválida.");

  return { ok: e.length === 0, errores: e };
}
