// ─────────────────────────────────────────────────────────────────────────────
// Verificación GRATIS de M1.5 (planner): prueba el núcleo DETERMINISTA sin modelo
// —la puerta de coherencia (vista ↔ contrato) y que una vista tipo-planner
// resuelve contra un resultado que cumple su contrato.
//
//   npm run verify:planner
// ─────────────────────────────────────────────────────────────────────────────
import type { Vista } from "../src/types.ts";
import type { ResultadoContrato } from "../src/planner/schema.ts";
import { validarCoherencia, contratoATexto } from "../src/planner/coherencia.ts";
import { resolverVista } from "../src/vista/resolver.ts";

let ok = true;
const check = (nombre: string, paso: boolean) => {
  console.log(`  ${paso ? "✓" : "✗"} ${nombre}`);
  ok = ok && paso;
};

// Contrato que el planner declararía para un dashboard chico.
const contrato: ResultadoContrato = {
  campos: [
    { ruta: "metricas.total", tipo: "numero", descripcion: "Total del periodo." },
    { ruta: "familias", tipo: "arreglo", descripcion: "Desglose por familia.", items: [{ campo: "familia", tipo: "texto" }, { campo: "ingreso", tipo: "numero" }] },
  ],
};

const vistaOk: Vista = {
  version_vista: 1,
  titulo: "Dashboard",
  archivoSalida: "x.xlsx",
  bloques: [
    { tipo: "resumen", texto: "Un resumen literal." },
    { tipo: "metricas", items: [{ etiqueta: "Total", valor: "@resultado.metricas.total", formato: "moneda" }] },
    { tipo: "barras", titulo: "Por familia", formato: "moneda", fuente: "@resultado.familias", eje_x: "familia", eje_y: "ingreso" },
  ],
};

console.log("1. Puerta de coherencia — acepta lo coherente, rechaza lo que el contrato no respalda:");
check("vista coherente pasa", validarCoherencia(vistaOk, contrato).ok);
check(
  "métrica que referencia un campo inexistente falla",
  !validarCoherencia(
    { ...vistaOk, bloques: [{ tipo: "metricas", items: [{ etiqueta: "X", valor: "@resultado.metricas.promedio", formato: "entero" }] }] },
    contrato,
  ).ok,
);
check(
  "gráfica con eje_y que no es campo del arreglo falla",
  !validarCoherencia(
    { ...vistaOk, bloques: [{ tipo: "barras", titulo: "T", formato: "moneda", fuente: "@resultado.familias", eje_x: "familia", eje_y: "utilidad" }] },
    contrato,
  ).ok,
);
check(
  "gráfica cuya fuente es un escalar (no arreglo) falla",
  !validarCoherencia(
    { ...vistaOk, bloques: [{ tipo: "barras", titulo: "T", formato: "moneda", fuente: "@resultado.metricas.total", eje_x: "a", eje_y: "b" }] },
    contrato,
  ).ok,
);

console.log("\n2. Resolve completo — vista del planner + resultado que cumple el contrato → Resultado:");
const resultadoDatos = {
  metricas: { total: 186440 },
  familias: [{ familia: "Cocina", ingreso: 92400 }, { familia: "Barra", ingreso: 68200 }],
};
const resultado = resolverVista(vistaOk, resultadoDatos);
check("resuelve el número de bloques", resultado.bloques.length === 3);
const met = resultado.bloques.find((b) => b.tipo === "metricas");
check("la métrica quedó enlazada al valor real", met?.tipo === "metricas" && met.items[0]?.valor === 186440);
const bar = resultado.bloques.find((b) => b.tipo === "barras");
check("la gráfica mapeó fuente→datos (eje_x/eje_y)", bar?.tipo === "barras" && bar.datos.length === 2 && bar.datos[0]?.etiqueta === "Cocina" && bar.datos[0]?.valor === 92400);

console.log("\n3. Contrato→texto (lo que el planner le pasa al builder como objetivo de salida):");
console.log(contratoATexto(contrato).split("\n").map((l) => "   " + l).join("\n"));

console.log(`\n${ok ? "✓ M1.5 (planner determinista) PROBADO" : "✗ FALLÓ"} — coherencia y resolve correctos, sin modelo.`);
process.exit(ok ? 0 : 1);
