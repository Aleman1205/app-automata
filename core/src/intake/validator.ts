import type { IntakeSpec } from "./schema.ts";

// Validación programática del spec (docs/10 §4). Corre DESPUÉS del esquema del
// modelo (que es best-effort, no garantía dura), atrapa lo que el JSON Schema no
// impone, y es determinista (sin modelo) — el corazón de la verificación de M1.

export interface Validacion {
  ok: boolean;
  errores: string[];
}

const MAX_STR = 400; // tope de longitud "en todo" (§4), anti-amplificación de inyección

function cortos(strs: unknown[], etiqueta: string, e: string[]): void {
  for (const [i, s] of strs.entries()) {
    if (typeof s === "string" && s.length > MAX_STR) {
      e.push(`${etiqueta} #${i + 1} excede ${MAX_STR} chars.`);
    }
  }
}

export function validarSpec(spec: IntakeSpec): Validacion {
  const e: string[] = [];

  // Guarda dura: el spec puede venir ausente/malformado del modelo — no crashear.
  if (!spec || typeof spec !== "object") {
    return { ok: false, errores: ["spec ausente o no es un objeto."] };
  }

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

  for (const [i, c] of (spec.criterios_exito ?? []).entries()) {
    if (!c?.criterio?.trim() || !c?.criterio_cliente?.trim()) {
      e.push(`criterio #${i + 1}: criterio y criterio_cliente no pueden estar vacíos.`);
    }
  }

  if (Array.isArray(spec.reglas) && spec.reglas.length > 15) e.push("máximo 15 reglas.");

  // Límites de longitud "en todo" (§4): ningún string arbitrario sin tope.
  if (Array.isArray(spec.reglas)) cortos(spec.reglas, "regla", e);
  if (Array.isArray(spec.ambiguedades_restantes)) cortos(spec.ambiguedades_restantes, "ambigüedad", e);
  if (Array.isArray(spec.criterios_exito)) {
    cortos(spec.criterios_exito.map((c) => c?.criterio), "criterio", e);
    cortos(spec.criterios_exito.map((c) => c?.criterio_cliente), "criterio_cliente", e);
  }
  for (const arr of [spec.entradas, spec.salidas]) {
    if (Array.isArray(arr)) cortos(arr.map((x: any) => x?.descripcion), "descripción", e);
  }

  // Regla clave del §4: baja confianza obliga a declarar las ambigüedades.
  if (spec.confianza === "baja" && (!spec.ambiguedades_restantes || spec.ambiguedades_restantes.length === 0)) {
    e.push("confianza 'baja' exige ambiguedades_restantes no vacías.");
  }
  if (!["alta", "media", "baja"].includes(spec.confianza)) e.push("confianza inválida.");

  return { ok: e.length === 0, errores: e };
}
