// Genera un .xlsx SINTÉTICO con la misma forma "sucia" que el reporte real de
// popularidad de productos, pero con cantidades y montos inventados. Reusa el
// catálogo de productos/familias (nombres del menú) para que se sienta real,
// sin exponer las cifras del negocio.
//
// Salida: spike/datos/gastos.xlsx  (sobrescribe el real — el real ya no se sube)
//
//   node spike/generar-gastos.js
//
// Determinista (semilla fija) para que los criterios del caso siempre cuadren.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "datos");
const catalogo = JSON.parse(
  fs.readFileSync(path.join(DIR, "_catalogo.json"), "utf8"),
);

// PRNG determinista (mulberry32) — sin Math.random, resultados reproducibles.
let semilla = 0x9e3779b9;
const rnd = () => {
  semilla |= 0;
  semilla = (semilla + 0x6d2b79f5) | 0;
  let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ent = (min, max) => Math.floor(min + rnd() * (max - min + 1));

// --- Generar cifras sintéticas por producto ---
const filas = catalogo.map((p) => {
  const cantidad = ent(1, 900);
  const precioUnit = 20 + rnd() * 480; // 20–500
  const ingreso = +(cantidad * precioUnit).toFixed(2);
  const margen = 0.15 + rnd() * 0.7; // 15%–85% de utilidad
  const utilidad = +(ingreso * margen).toFixed(2);
  const costo = +(ingreso - utilidad).toFixed(2);
  return { ...p, cantidad, ingreso, costo, utilidad };
});

// Totales para las columnas de %
const totCant = filas.reduce((s, f) => s + f.cantidad, 0);
const totIng = filas.reduce((s, f) => s + f.ingreso, 0);
const totCost = filas.reduce((s, f) => s + f.costo, 0);
const totUtil = filas.reduce((s, f) => s + f.utilidad, 0);
const pct = (v, t) => `${((100 * v) / t).toFixed(2)} %`;

// --- Construir el xlsx con la MISMA estructura sucia que el real ---
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Popularidad de Productos");

// Cabecera de reporte (filas 1–3), como el original
ws.getCell("A1").value = "Alpino Chipinque";
ws.getCell("A2").value = "Reporte Popularidad de Productos";
ws.getCell("A3").value = "Fecha Sistema: 2026-03-18";

// Encabezado de la tabla de detalle (fila 5)
ws.getRow(5).values = [
  "Pdv", "Nombre", "Clave", "Producto", "Tipo", "Fam", "Familia",
  "Cantidad", "% Cantidad", "Ingreso", "% Ingreso", "Costo", "% Costo",
  "Utilidad", "% Utilidad",
];

// Detalle por producto (fila 6 en adelante), ordenado por ingreso desc como el real
filas.sort((a, b) => b.ingreso - a.ingreso);
let r = 6;
let clave = 1;
for (const f of filas) {
  ws.getRow(r).values = [
    "VIT01", "VITRALES", clave++, f.producto, f.tipo, f.fam, f.familia,
    f.cantidad, pct(f.cantidad, totCant),
    f.ingreso, pct(f.ingreso, totIng),
    f.costo, pct(f.costo, totCost),
    f.utilidad, pct(f.utilidad, totUtil),
  ];
  r++;
}

// BASURA #1: fila "Total" del detalle (columnas corridas, como el real)
ws.getCell(`D${r}`).value = totCant;
ws.getCell(`G${r}`).value = "Total";
ws.getCell(`J${r}`).value = totUtil; // en el real, aquí venía la utilidad, no el ingreso
r += 2;

// BASURA #2: segunda tabla apilada — "Totales por Familia" con su encabezado propio
ws.getCell(`A${r}`).value = "TOTALES POR FAMILIA";
r++;
ws.getRow(r).values = ["ID PDV", "", "", "", "", "", "Familia", "Cantidad", "% Cantidad", "Ingreso", "% Ingreso"];
r++;
const porFam = {};
for (const f of filas) {
  porFam[f.familia] ??= { cant: 0, ing: 0 };
  porFam[f.familia].cant += f.cantidad;
  porFam[f.familia].ing += f.ingreso;
}
for (const [fam, v] of Object.entries(porFam)) {
  ws.getRow(r).values = ["VIT01", "", "", "", "", "", fam, v.cant, pct(v.cant, totCant), +v.ing.toFixed(2), pct(v.ing, totIng)];
  r++;
}
// Gran total de la segunda tabla
ws.getRow(r).values = ["VIT01", "", "", totCant, "", "", "100.00 %", totCant, "100.00 %", +totIng.toFixed(2), "100.00 %"];

await wb.xlsx.writeFile(path.join(DIR, "gastos.xlsx"));

// --- Reporte de los números correctos (para escribir/validar el rubric) ---
const top = filas.slice(0, 3).map((f) => `${f.producto} ($${Math.round(f.ingreso).toLocaleString()})`);
console.log("✓ gastos.xlsx sintético generado (estructura sucia, cifras inventadas)");
console.log("  Productos (detalle):", filas.length);
console.log("  Familias:", Object.keys(porFam).length);
console.log("  Cantidad total:", totCant);
console.log("  Ingreso total:  $" + totIng.toFixed(2));
console.log("  Costo total:    $" + totCost.toFixed(2));
console.log("  Utilidad total: $" + totUtil.toFixed(2));
console.log("  Margen:", ((100 * totUtil) / totIng).toFixed(1) + "%");
console.log("  Top 3 por ingreso:", top.join(" · "));
