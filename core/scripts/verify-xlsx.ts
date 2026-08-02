// ─────────────────────────────────────────────────────────────────────────────
// El ENTREGABLE .xlsx (core/src/salida/xlsx.ts). Se genera el workbook y se vuelve a LEER con
// ExcelJS: afirmar sobre el objeto en memoria no probaría nada — lo que importa es lo que queda
// escrito en el archivo que el cliente abre en Excel.
//   npm run verify:xlsx
// ─────────────────────────────────────────────────────────────────────────────
import ExcelJS from "exceljs";
import { aXlsx } from "../src/salida/xlsx.ts";
import type { Resultado } from "../src/types.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

// Celda HOSTIL: en un .csv, Excel la ejecuta al importar (por eso existe neutralizarCelda).
const HOSTIL = "=cmd|'/c calc'!A1";

const resultado: Resultado = {
  archivoSalida: "resultado.json",
  bloques: [
    { seccion: "resumen", tipo: "resumen", texto: "Se conciliaron 1,281 de 1,284 movimientos." },
    { seccion: "resumen", tipo: "metricas", items: [
      { etiqueta: "Saldo según libros", valor: 847392.18, formato: "moneda" },
      { etiqueta: "Diferencia neta", valor: 0.37, formato: "moneda" },
      { etiqueta: "Conciliado", valor: 98.4, formato: "porcentaje" },
    ] },
    { seccion: "resumen", tipo: "callout", tono: "alerta", titulo: "3 partidas sin conciliar", texto: "Por $36.37." },
    { seccion: "detalle", tipo: "tabla", titulo: "Conciliados", columnas: [
      { campo: "ref", etiqueta: "Referencia" },
      { campo: "monto", etiqueta: "Monto", formato: "moneda", alinear: "derecha" },
      { campo: "estatus", etiqueta: "Estatus", formato: "estado" },
    ], filas: [
      { ref: "SPEI-88231", monto: 124500, estatus: "Conciliado" },
      { ref: "CHQ-01192", monto: 43199.63, estatus: "Con tolerancia" },
      { ref: HOSTIL, monto: -0.37, estatus: "Sin conciliar" },
    ] },
    { seccion: "detalle", tipo: "tabla", titulo: "En banco, no en registro", columnas: [
      { campo: "ref", etiqueta: "Referencia" },
    ], filas: [{ ref: "DEP-77120" }] },
  ],
};

async function leer(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

async function main() {
  const buf = await aXlsx(resultado, {
    titulo: "Conciliación de pagos — julio",
    cuando: "Ejecutada el 1 de agosto de 2026",
    parametros: [{ etiqueta: "Tolerancia de monto", valor: "$1.00 MXN" }],
  });

  console.log("1. El archivo se genera y Excel lo puede volver a abrir:");
  check("produce bytes de xlsx (PK zip)", buf.length > 1000 && buf[0] === 0x50 && buf[1] === 0x4b);
  const wb = await leer(buf);
  const hojas = wb.worksheets.map((h) => h.name);
  check(`se relee sin corromperse (${hojas.length} hojas)`, hojas.length >= 4);

  console.log("\n2. UNA HOJA POR TABLA, no una sola de 'Detalle':");
  // En Excel se filtra y se ordena POR HOJA. Mezclar conciliados con no-conciliados en la misma
  // vuelve inútiles las dos, que es justo lo que el cliente hace primero al abrir el archivo.
  check("hoja 'Conciliados'", hojas.includes("Conciliados"));
  check("hoja 'En banco, no en registro'", hojas.includes("En banco, no en registro"));
  check("hoja de Resumen al frente", hojas[0] === "Resumen");
  check("hoja 'A revisar' aunque no haya tabla de excepciones", hojas.includes("A revisar"));
  check("hoja 'Parámetros'", hojas.includes("Parámetros"));

  console.log("\n3. INYECCIÓN DE FÓRMULAS — lo que el cliente subió NO se evalúa:");
  // Es la garantía que se rompe sola: basta que alguien escriba `cell.value = { formula: v }` en
  // cualquier refactor. En .xlsx el tipo de celda es explícito, así que texto se queda texto —
  // pero eso hay que VIGILARLO, no suponerlo.
  const conc = wb.getWorksheet("Conciliados")!;
  const celdaHostil = conc.getCell("A4");
  check("la celda hostil conserva su texto literal", celdaHostil.value === HOSTIL);
  check("NO quedó como fórmula (nada que Excel ejecute al abrir)",
    typeof celdaHostil.value !== "object" || celdaHostil.value === null || !("formula" in (celdaHostil.value as object)));
  check("ninguna celda del libro es una fórmula", wb.worksheets.every((h) => {
    let limpio = true;
    h.eachRow((r) => r.eachCell((c) => { if (c.type === ExcelJS.ValueType.Formula) limpio = false; }));
    return limpio;
  }));

  console.log("\n4. Formatos: el dinero con centavos, el porcentaje en la escala de Excel:");
  check("la columna de moneda lleva numFmt con 2 decimales", /0\.00/.test(conc.getCell("B2").numFmt ?? ""));
  check("43,199.63 se guarda como NÚMERO (no texto): Excel puede sumarlo", conc.getCell("B3").value === 43199.63);
  check("el negativo de 37 centavos sobrevive", conc.getCell("B4").value === -0.37);
  const res = wb.getWorksheet("Resumen")!;
  // Excel multiplica por 100 al pintar un formato de porcentaje: si se guardara 98.4 mostraría
  // "9840.0%". El generador divide, y esto lo comprueba en el archivo real.
  let pct: unknown;
  res.eachRow((r) => { if (String(r.getCell(1).value ?? "") === "Conciliado") pct = r.getCell(2).value; });
  check("98.4% se guarda como 0.984 (Excel multiplica al pintar)", typeof pct === "number" && Math.abs(pct - 0.984) < 1e-9);

  console.log("\n5. Semáforo: el color viaja en el archivo, no solo en pantalla:");
  const relleno = (ref: string) => (conc.getCell(ref).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
  check("'Conciliado' pintado (verde)", !!relleno("C2"));
  check("'Con tolerancia' pintado, y DISTINTO del verde (ámbar)", !!relleno("C3") && relleno("C3") !== relleno("C2"));
  check("'Sin conciliar' pintado, y distinto de los otros dos (rojo)",
    !!relleno("C4") && relleno("C4") !== relleno("C2") && relleno("C4") !== relleno("C3"));

  console.log("\n6. Usabilidad de la hoja (lo primero que hace cualquiera con 500 filas):");
  check("encabezado congelado", conc.views?.[0]?.state === "frozen");
  check("autofiltro puesto", !!conc.autoFilter);
  check("las columnas tienen ancho (sin esto los importes salen como ####)",
    (conc.getColumn(1).width ?? 0) > 8);

  console.log("\n7. Nombres de hoja (Excel no abre el archivo si se repiten o pasan de 31):");
  const largo: Resultado = { archivoSalida: "r.json", bloques: [
    { seccion: "detalle", tipo: "tabla", titulo: "Partidas conciliatorias del ejercicio anterior", columnas: [{ campo: "a", etiqueta: "A" }], filas: [] },
    { seccion: "detalle", tipo: "tabla", titulo: "Partidas conciliatorias del ejercicio siguiente", columnas: [{ campo: "a", etiqueta: "A" }], filas: [] },
  ] };
  const wb2 = await leer(await aXlsx(largo, { titulo: "X" }));
  const n2 = wb2.worksheets.map((h) => h.name);
  check("ninguna hoja pasa de 31 caracteres", n2.every((n) => n.length <= 31));
  check("dos títulos que se truncan igual NO colisionan", new Set(n2.map((n) => n.toLowerCase())).size === n2.length);

  console.log(`\n${ok ? "✓ ENTREGABLE .XLSX PROBADO" : "✗ FALLÓ"} — una hoja por tabla, centavos, semáforo, y nada que Excel ejecute.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
