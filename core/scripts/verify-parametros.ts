// ─────────────────────────────────────────────────────────────────────────────
// La sección PARÁMETROS (core/src/vista/parametros.ts): con qué reglas se produjo el resultado.
//
// Es lo que vuelve el reporte defendible y la corrida reproducible. Se deriva del spec del intake
// UNA sola vez y lo consumen la pantalla y la hoja del .xlsx: si cada uno lo interpretara por su
// cuenta, el archivo y lo que el cliente vio acabarían contando cosas distintas.
//   npm run verify:parametros
// ─────────────────────────────────────────────────────────────────────────────
import { parametrosDeSpec, bloqueParametros, bloqueDeParametros } from "../src/vista/parametros.ts";
import type { Spec } from "../src/types.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

const spec: Spec = {
  objetivo: "Conciliar los pagos del mes contra el estado de cuenta.",
  reglas: ["Tolerancia de monto: $1.00 MXN", "Tolerancia de fecha: ± 3 días", "Cruzar por referencia"],
  criterios_exito: ["Toda partida sin contraparte queda listada con su motivo"],
  entradas: [{ tipo: "archivo", formato: "xlsx", descripcion: "Estado de cuenta del banco" }],
};

console.log("1. El spec se aplana a filas legibles:");
const filas = parametrosDeSpec(spec);
check("incluye el objetivo", filas.some((f) => f.etiqueta === "Qué hace" && /Conciliar/.test(f.valor)));
// UNA fila por regla y no un párrafo con todas: así se pueden leer y citar una por una, que es lo
// que hace alguien discutiendo un número concreto del reporte.
check("una fila POR REGLA (3 reglas → 3 filas)", filas.filter((f) => /^Regla \d+$/.test(f.etiqueta)).length === 3);
check("las reglas se numeran sin repetir etiqueta",
  new Set(filas.filter((f) => f.etiqueta.startsWith("Regla")).map((f) => f.etiqueta)).size === 3);
check("incluye los criterios de aceptación", filas.some((f) => f.etiqueta === "Criterio 1"));
check("incluye los insumos con su formato", filas.some((f) => f.etiqueta === "Insumo 1" && /xlsx/.test(f.valor)));
check("la tolerancia REAL aparece textual (es lo que se va a citar)",
  filas.some((f) => f.valor.includes("$1.00 MXN")));

console.log("\n2. Nada que mostrar → NO se inventa una pestaña:");
// Distinto de 'revisar', donde el vacío SÍ informa ("no hubo excepciones"). Una pestaña de
// Parámetros vacía promete información y no la da.
check("sin spec → sin filas", parametrosDeSpec(undefined).length === 0);
check("sin spec → sin bloque", bloqueParametros(undefined) === null);
check("spec vacío → sin bloque",
  bloqueParametros({ objetivo: "", reglas: [], criterios_exito: [], entradas: [] }) === null);
check("reglas en blanco no cuentan como reglas",
  parametrosDeSpec({ objetivo: "x", reglas: ["", "   "], criterios_exito: [], entradas: [] }).length === 1);

console.log("\n3. El bloque va a la sección correcta y con la forma que el front sabe pintar:");
const b = bloqueParametros(spec)!;
check("es un bloque de tabla", b.tipo === "tabla");
check("declara seccion 'parametros'", b.seccion === "parametros");
check("tiene columnas etiqueta/valor", b.tipo === "tabla" && b.columnas.map((c) => c.campo).join(",") === "etiqueta,valor");
check("trae todas las filas derivadas", b.tipo === "tabla" && b.filas.length === filas.length);

console.log("\n4. Pantalla y .xlsx comparten el derivador (no pueden discrepar):");
// El endpoint de detalle manda las FILAS ya derivadas y el front arma su bloque con ellas; el
// wiring del xlsx llama a parametrosDeSpec. Los dos caminos tienen que dar lo mismo.
const desdeFilas = bloqueDeParametros(parametrosDeSpec(spec));
check("bloqueDeParametros(filas) == bloqueParametros(spec)", JSON.stringify(desdeFilas) === JSON.stringify(b));
check("bloqueDeParametros([]) → null (mismo criterio de vacío)", bloqueDeParametros([]) === null);

console.log(`\n${ok ? "✓ PARÁMETROS PROBADOS" : "✗ FALLÓ"} — el spec del intake llega al entregable, y sin spec no se inventa la pestaña.`);
process.exit(ok ? 0 : 1);
