// Genera los archivos de prueba en spike/datos/ para poder correr el spike
// sin tener que preparar nada. Sustitúyelos por archivos reales cuando puedas:
// los datos sintéticos son demasiado limpios y hacen ver el sistema mejor de
// lo que es.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "datos");
fs.mkdirSync(dir, { recursive: true });

const escribir = (nombre, filas) => {
  fs.writeFileSync(path.join(dir, nombre), filas.join("\n") + "\n");
  console.log(`  ${nombre}  (${filas.length - 1} filas)`);
};

// --- ventas.csv ---
const vendedores = ["Ana Ruiz", "Luis Mora", "Carmen Diaz", "Jorge Pena"];
const ventas = ["fecha,vendedor,monto,estado"];
for (let mes = 1; mes <= 3; mes++) {
  for (let i = 0; i < 40; i++) {
    const dia = String((i % 27) + 1).padStart(2, "0");
    const v = vendedores[i % vendedores.length];
    const monto = (500 + ((i * 137 + mes * 91) % 4500)).toFixed(2);
    const estado = i % 11 === 0 ? "cancelada" : "completada";
    ventas.push(`2026-${String(mes).padStart(2, "0")}-${dia},${v},${monto},${estado}`);
  }
}

// --- facturas.csv --- (mismo RFC escrito de formas distintas, a propósito)
const provs = [
  ["Distribuidora del Norte SA de CV", "DNO950101AB1"],
  ["DISTRIBUIDORA DEL NORTE S.A.", "DNO950101AB1"],
  ["Papeleria Central", "PCE010203XY2"],
  ["Servicios Integrales GZ", "SIG880404ZZ9"],
];
const facturas = ["folio,proveedor,rfc,monto,iva,estado"];
for (let i = 0; i < 60; i++) {
  const [nombre, rfc] = provs[i % provs.length];
  const monto = 1000 + ((i * 311) % 9000);
  facturas.push(
    `F-${1000 + i},${nombre},${rfc},${monto.toFixed(2)},${(monto * 0.16).toFixed(2)},` +
      (i % 13 === 0 ? "cancelada" : "vigente"),
  );
}

// --- contactos.csv --- (duplicados, mayúsculas, espacios y emails rotos)
const contactos = ["nombre,email,telefono"];
const base = [
  ["Ana Ruiz", "ana@ejemplo.com"],
  ["Ana Ruiz", "  ANA@Ejemplo.com "],
  ["Luis Mora", "luis@ejemplo.com"],
  ["Carmen Diaz", "carmen(arroba)ejemplo.com"],
  ["Jorge Pena", "jorge@ejemplo.com"],
  ["Jorge P.", "JORGE@ejemplo.com"],
  ["Sin Correo", ""],
  ["Rosa Lima", "rosa@ejemplo"],
];
for (let i = 0; i < 50; i++) {
  const [n, e] = base[i % base.length];
  contactos.push(`${n},${e},55${String(10000000 + i * 137).slice(0, 8)}`);
}

console.log("Generando datos de prueba en spike/datos/:");
escribir("ventas.csv", ventas);
escribir("facturas.csv", facturas);
escribir("contactos.csv", contactos);
console.log("\nListo. Ahora: npm run spike");
