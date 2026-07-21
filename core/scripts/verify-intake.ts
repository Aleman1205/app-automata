// ─────────────────────────────────────────────────────────────────────────────
// Verificación GRATIS de M1: prueba el núcleo DETERMINISTA del intake sin modelo
// —el validador del spec (§4) y el adaptador al build de M0— con fixtures.
// La calidad de las PREGUNTAS del modelo se prueba aparte con `npm run intake:live`.
//
//   npm run verify:intake
// ─────────────────────────────────────────────────────────────────────────────
import { intakeSpecABuildSpec } from "../src/intake/adapter.ts";
import { validarSpec } from "../src/intake/validator.ts";
import type { IntakeSpec } from "../src/intake/schema.ts";

let ok = true;
const check = (nombre: string, paso: boolean) => {
  console.log(`  ${paso ? "✓" : "✗"} ${nombre}`);
  ok = ok && paso;
};

// Un spec válido (el que la entrevista de Vitrales debería producir).
const specValido: IntakeSpec = {
  version: 1,
  objetivo: "A partir del reporte de popularidad de productos, producir un dashboard con métricas, desglose por familia y top de productos.",
  entradas: [{ tipo: "archivo", formato: "xlsx", descripcion: "Reporte de popularidad exportado del sistema." }],
  salidas: [{ tipo: "pantalla", formato: "dashboard", descripcion: "Métricas + familias + top." }],
  reglas: ["Usa solo el detalle de producto.", "Agrupa por familia.", "Margen = utilidad / ingreso."],
  criterios_exito: [
    { criterio: "El JSON tiene metricas, familias y top_productos.", criterio_cliente: "Ves las métricas, el desglose por familia y el top." },
    { criterio: "El ingreso total cuadra con la suma del detalle (±0.5%).", criterio_cliente: "Los totales cuadran con tu archivo." },
  ],
  ambiguedades_restantes: [],
  confianza: "alta",
};

console.log("1. Validador del spec (§4) — acepta el válido, rechaza los rotos:");
check("spec válido pasa", validarSpec(specValido).ok);
check("objetivo muy corto falla", !validarSpec({ ...specValido, objetivo: "corto" }).ok);
check("1 solo criterio falla", !validarSpec({ ...specValido, criterios_exito: [specValido.criterios_exito[0]!] }).ok);
check("sin entradas falla", !validarSpec({ ...specValido, entradas: [] }).ok);
check("sin salidas falla", !validarSpec({ ...specValido, salidas: [] }).ok);
check(
  "confianza 'baja' sin ambigüedades falla",
  !validarSpec({ ...specValido, confianza: "baja", ambiguedades_restantes: [] }).ok,
);
check(
  "confianza 'baja' CON ambigüedades pasa",
  validarSpec({ ...specValido, confianza: "baja", ambiguedades_restantes: ["falta el formato exacto"] }).ok,
);
check(
  "criterio con lado vacío falla",
  !validarSpec({
    ...specValido,
    criterios_exito: [{ criterio: "algo", criterio_cliente: "" }, specValido.criterios_exito[1]!],
  }).ok,
);
// Regresión de la revisión adversarial:
check("spec ausente NO crashea y falla", !validarSpec(undefined as unknown as IntakeSpec).ok);
check("regla larguísima falla (maxLength §4)", !validarSpec({ ...specValido, reglas: ["x".repeat(500)] }).ok);

console.log("\n2. Adaptador intake→build — produce un Spec que el Builder consume:");
const buildSpec = intakeSpecABuildSpec(specValido);
check("objetivo se conserva", buildSpec.objetivo === specValido.objetivo);
check("reglas se conservan", buildSpec.reglas.length === 3);
check("criterios se aplanan al lado técnico", buildSpec.criterios_exito.length === 2 && buildSpec.criterios_exito.every((c) => typeof c === "string"));
check("criterio técnico (no el de cliente) es el que viaja", buildSpec.criterios_exito[0] === specValido.criterios_exito[0]!.criterio);
check("entradas: formato null→'' y tipos conservados", buildSpec.entradas[0]!.formato === "xlsx" && buildSpec.entradas[0]!.tipo === "archivo");

console.log(`\n${ok ? "✓ M1 (núcleo determinista) PROBADO" : "✗ FALLÓ"} — validador y adaptador correctos, sin modelo.`);
process.exit(ok ? 0 : 1);
