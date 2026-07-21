import type { Spec } from "../types.ts";
import type { IntakeSpec } from "./schema.ts";

// El spec del intake (rico, bilingüe, docs/10 §4) → el Spec que consume el Builder
// de M0. Los criterios técnicos (`criterio`) van al rubric del Verifier; el lado
// `criterio_cliente` se queda para la pantalla de aprobación (no viaja al build).
export function intakeSpecABuildSpec(spec: IntakeSpec): Spec {
  return {
    objetivo: spec.objetivo,
    reglas: spec.reglas,
    criterios_exito: spec.criterios_exito.map((c) => c.criterio),
    entradas: spec.entradas.map((en) => ({
      tipo: en.tipo,
      formato: en.formato ?? "",
      descripcion: en.descripcion,
    })),
  };
}
