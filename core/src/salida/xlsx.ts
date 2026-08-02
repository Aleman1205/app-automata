// ─────────────────────────────────────────────────────────────────────────────
// EL ENTREGABLE: el resultado como workbook .xlsx.
//
// Es el formato que el contador re-importa a CONTPAQi/Aspel y el que se archiva. El .csv sirve
// para importar una tabla; el .xlsx es el reporte completo, con sus pestañas, sus formatos de
// moneda y su semáforo — o sea, lo que el cliente reconoce como "un reporte".
//
// Lo genera LA PLATAFORMA, no el script del agente. Podría pedírsele al agente que escribiera el
// xlsx con openpyxl, pero entonces cada automatización tendría su propio criterio de formato y
// habría que confiar en que el modelo acierte con los anchos de columna. Aquí, en cambio, el
// esqueleto de secciones (types.ts:Seccion) ya trae toda la información necesaria: una sola
// función le da .xlsx a todas las automatizaciones, las de hoy y las que se construyan mañana.
//
// UNA PESTAÑA POR TABLA, no una sola de "detalle". En pantalla las tablas de detalle conviven en
// una sección; en el archivo van separadas, porque en Excel se filtra y se ordena por hoja y
// mezclar conciliados con no-conciliados en la misma hace ilegible las dos.
//
// SOBRE LA INYECCIÓN DE FÓRMULAS: aquí NO aplica el problema del .csv. En un .csv, Excel parsea al
// importar y una celda `=cmd|'/c calc'!A1` se EJECUTA (por eso existe `neutralizarCelda` en
// salida/csv.ts). En un .xlsx, en cambio, el tipo de celda es explícito en el XML: lo que se
// escribe como texto se queda como texto y no se evalúa jamás. La condición es no meter nunca el
// valor del cliente en `cell.value = { formula: … }`, y este módulo no lo hace en ningún camino.
// Hay un check dedicado a eso en verify:xlsx, porque es la clase de garantía que se rompe sola.
// ─────────────────────────────────────────────────────────────────────────────
import ExcelJS from "exceljs";
import type { Bloque, ColumnaDemo, Resultado, Seccion } from "../types.ts";
import { tonoDeEstado, type TonoEstado } from "../vista/formato.ts";

// Formatos numéricos de Excel. El de moneda lleva centavos SIEMPRE, por la misma razón que en
// pantalla: el descuadre de una conciliación vive ahí y redondear a pesos lo desaparece.
const NUMFMT: Record<string, string> = {
  moneda: '"$"#,##0.00',
  porcentaje: "0.0%",
  entero: "#,##0",
};

// El semáforo, en relleno + color de letra. Mismos tres estados que la pantalla, resueltos con la
// MISMA función (`tonoDeEstado`): si el vocabulario cambia, cambia en los dos a la vez.
const RELLENO: Record<TonoEstado, { bg: string; fg: string } | null> = {
  ok: { bg: "FFE8F0DC", fg: "FF4A5A28" },
  revisar: { bg: "FFFBEFD3", fg: "FF7A560F" },
  alerta: { bg: "FFF6DED8", fg: "FF7C2D1B" },
  neutro: null, // sin relleno: "no lo reconocimos" no merece color
};

const TITULO_SECCION: Record<Seccion, string> = {
  resumen: "Resumen",
  detalle: "Detalle",
  revisar: "A revisar",
  parametros: "Parámetros",
};

/** Excel corta los nombres de hoja a 31 caracteres y prohíbe : \ / ? * [ ]. Dos hojas con el
 *  mismo nombre hacen que el archivo no abra, así que se desempata con un sufijo. */
function nombreHoja(base: string, usados: Set<string>): string {
  const limpio = (base || "Hoja").replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || "Hoja";
  let n = limpio;
  let i = 2;
  while (usados.has(n.toLowerCase())) {
    const sufijo = ` (${i++})`;
    n = `${limpio.slice(0, 31 - sufijo.length)}${sufijo}`;
  }
  usados.add(n.toLowerCase());
  return n;
}

/** Ancho de columna por el contenido real, acotado. Sin esto todo sale a 8 caracteres y el
 *  cliente abre el archivo viendo `####` en cada importe — parece que el reporte está roto. */
function anchoDe(col: ColumnaDemo, filas: Record<string, string | number>[]): number {
  const largos = filas.slice(0, 200).map((f) => String(f[col.campo] ?? "").length);
  return Math.min(46, Math.max(col.etiqueta.length + 2, ...largos, 8) + 2);
}

function escribirTabla(
  hoja: ExcelJS.Worksheet,
  columnas: ColumnaDemo[],
  filas: Record<string, string | number>[],
) {
  hoja.columns = columnas.map((c) => ({ header: c.etiqueta, key: c.campo, width: anchoDe(c, filas) }));
  const enc = hoja.getRow(1);
  enc.font = { bold: true, color: { argb: "FF1D1710" } };
  enc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFE8D8" } };
  enc.border = { bottom: { style: "thin", color: { argb: "FFDCD3BE" } } };
  // El encabezado se congela y se activa el autofiltro: es lo primero que hace cualquiera con una
  // tabla de 500 renglones, y no traerlo obliga al cliente a configurarlo cada vez.
  hoja.views = [{ state: "frozen", ySplit: 1 }];
  hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };

  for (const fila of filas) {
    const r = hoja.addRow(columnas.reduce<Record<string, string | number>>((o, c) => {
      o[c.campo] = fila[c.campo] ?? "";
      return o;
    }, {}));
    columnas.forEach((c, i) => {
      const celda = r.getCell(i + 1);
      if (c.formato && NUMFMT[c.formato] && typeof celda.value === "number") {
        celda.numFmt = NUMFMT[c.formato]!;
        // El porcentaje de Excel multiplica por 100 al pintar; el resultado trae 98.4 y no 0.984.
        if (c.formato === "porcentaje") celda.value = (celda.value as number) / 100;
      }
      if (c.formato === "estado") {
        const t = RELLENO[tonoDeEstado(String(celda.value ?? ""))];
        if (t) {
          celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: t.bg } };
          celda.font = { color: { argb: t.fg }, bold: true };
        }
      }
      if (c.alinear === "derecha") celda.alignment = { horizontal: "right" };
    });
  }
}

export interface OpcionesXlsx {
  /** Nombre de la automatización: encabeza la hoja de Resumen. */
  titulo: string;
  /** Cuándo se corrió, ya formateado por el llamador (el core no decide zona horaria). */
  cuando?: string;
  /** Lo que capturó el intake. Alimenta la hoja de Parámetros, que es lo que hace auditable el
   *  reporte: cuando el contador pregunte "¿por qué esto quedó fuera?", la respuesta está aquí. */
  parametros?: { etiqueta: string; valor: string }[];
}

/** Convierte un Resultado ya resuelto en un workbook .xlsx. */
export async function aXlsx(resultado: Resultado, opciones: OpcionesXlsx): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(0); // determinista: dos corridas del mismo dato dan el mismo archivo
  const usados = new Set<string>();
  const de = (s: Seccion): Bloque[] => resultado.bloques.filter((b) => (b.seccion ?? "detalle") === s);

  // ── Resumen: las cifras y el veredicto, sin tablas largas ──
  const resumen = wb.addWorksheet(nombreHoja(TITULO_SECCION.resumen, usados));
  resumen.getColumn(1).width = 42;
  resumen.getColumn(2).width = 26;
  resumen.addRow([opciones.titulo]).font = { bold: true, size: 14 };
  if (opciones.cuando) resumen.addRow([opciones.cuando]).font = { color: { argb: "FF7C6F5C" } };
  resumen.addRow([]);
  for (const b of de("resumen")) {
    if (b.tipo === "resumen") resumen.addRow([b.texto]);
    if (b.tipo === "callout") {
      const r = resumen.addRow([b.titulo, b.texto ?? ""]);
      r.font = { bold: true, color: { argb: b.tono === "alerta" ? "FF7C2D1B" : "FF4A5A28" } };
    }
    if (b.tipo === "metricas") {
      resumen.addRow([]);
      for (const m of b.items) {
        const r = resumen.addRow([m.etiqueta, m.valor]);
        const c = r.getCell(2);
        c.numFmt = NUMFMT[m.formato] ?? NUMFMT.entero!;
        if (m.formato === "porcentaje") c.value = (c.value as number) / 100;
        c.font = { bold: true };
      }
    }
    if (b.tipo === "comparacion") {
      resumen.addRow([]);
      resumen.addRow([b.titulo]).font = { bold: true };
      for (const p of b.pasos) resumen.addRow([p.etiqueta, p.valor]).getCell(2).numFmt = NUMFMT.entero!;
    }
  }

  // ── Detalle y A revisar: UNA HOJA POR TABLA ──
  for (const seccion of ["detalle", "revisar"] as const) {
    const bloques = de(seccion);
    const tablas = bloques.filter((b): b is Extract<Bloque, { tipo: "tabla" }> => b.tipo === "tabla");
    for (const t of tablas) {
      escribirTabla(wb.addWorksheet(nombreHoja(t.titulo ?? TITULO_SECCION[seccion], usados)), t.columnas, t.filas);
    }
    // 'A revisar' SIEMPRE existe como hoja, aunque no haya nada. Vacía dice "todo se pudo leer",
    // que es información; ausente haría pensar que el reporte no revisó nada.
    if (seccion === "revisar" && tablas.length === 0) {
      const h = wb.addWorksheet(nombreHoja(TITULO_SECCION.revisar, usados));
      h.getColumn(1).width = 70;
      const textos = bloques.flatMap((b) => (b.tipo === "callout" ? [b.titulo, b.texto ?? ""] : []));
      h.addRow([textos[0] ?? "No hubo nada que revisar"]).font = { bold: true };
      if (textos[1]) h.addRow([textos[1]]);
    }
  }

  // ── Parámetros: qué reglas se aplicaron. Hace el reporte defendible. ──
  if (opciones.parametros?.length) {
    const h = wb.addWorksheet(nombreHoja(TITULO_SECCION.parametros, usados));
    h.getColumn(1).width = 34;
    h.getColumn(2).width = 52;
    h.addRow(["Parámetro", "Valor"]).font = { bold: true };
    for (const p of opciones.parametros) h.addRow([p.etiqueta, p.valor]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
