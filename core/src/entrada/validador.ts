import {
  EXTENSIONES, LIMITES, type Archivo, type Extension, type Familia, type Limites,
  type ResultadoArchivo, type ResultadoLote, type Veredicto,
} from "./tipos.ts";
import { detectarFamilia, escanearXxe, inspeccionarZip, dimensiones, pareceXml } from "./deteccion.ts";

// ─────────────────────────────────────────────────────────────────────────────
// La decisión. validarArchivo() gatea UN archivo; validarLote() añade el sobre
// agregado (docs/11 §4bis). Todo determinista, sin inflar. Un archivo cae en:
//   aceptado   — formato conocido y dentro de topes → puede ir al Builder/runner
//   a_revisar  — ilegible/desconocido → cuarentena, NUNCA se inventa (docs/09)
//   rechazado  — hostil o fuera de tope → no toca nada más
// ─────────────────────────────────────────────────────────────────────────────

// Qué familias estructurales admite cada extensión declarada (para cazar spoofing).
const ESPERADO: Record<Extension, Familia[]> = {
  png: ["png"],
  jpg: ["jpeg"],
  jpeg: ["jpeg"],
  zip: ["zip"],
  xlsx: ["zip"],
  xls: ["ole", "zip"], // .xls viejo = OLE; algunos vienen mal-etiquetados como zip
  pdf: ["pdf"],
  csv: ["texto", "desconocida"],
  txt: ["texto", "desconocida"],
  xml: ["texto", "desconocida"],
};

const normExt = (e: string): string => e.trim().toLowerCase().replace(/^\./, "");

const rechazo = (nombre: string, familia: Familia, motivo: ResultadoArchivo["motivo"], detalle?: string): ResultadoArchivo =>
  ({ nombre, veredicto: "rechazado", familia, motivo, detalle });

export interface ResultadoArchivoExt extends ResultadoArchivo {
  expansion: number; // bytes que este archivo ocupa ya expandido (para el sobre agregado)
}

export function validarArchivo(a: Archivo, lim: Limites = LIMITES): ResultadoArchivoExt {
  const familiaVacia: Familia = "desconocida";
  if (a.bytes.length === 0) return { ...rechazo(a.nombre, familiaVacia, "vacio"), expansion: 0 };
  if (a.bytes.length > lim.maxBytesArchivo) {
    return { ...rechazo(a.nombre, familiaVacia, "excede_tamano", `${a.bytes.length} bytes`), expansion: a.bytes.length };
  }

  const ext = normExt(a.extension);
  if (!(EXTENSIONES as readonly string[]).includes(ext)) {
    return { ...rechazo(a.nombre, familiaVacia, "tipo_no_permitido", ext || "(sin extensión)"), expansion: a.bytes.length };
  }

  const familia = detectarFamilia(a.bytes);

  // Ejecutable disfrazado (renombrado a .csv, etc.) → fuera, siempre.
  if (familia === "ejecutable") {
    return { ...rechazo(a.nombre, familia, "spoofing", "magic bytes de ejecutable"), expansion: a.bytes.length };
  }
  // La familia real debe ser una de las esperadas por la extensión declarada.
  if (!ESPERADO[ext as Extension].includes(familia)) {
    return { ...rechazo(a.nombre, familia, "spoofing", `.${ext} pero magic=${familia}`), expansion: a.bytes.length };
  }

  // Chequeo profundo según la familia REAL detectada.
  switch (familia) {
    case "zip": {
      const z = inspeccionarZip(a.bytes, lim.zip);
      if (z.motivo) return { ...rechazo(a.nombre, familia, z.motivo, z.detalle), expansion: z.descomprimidoTotal || a.bytes.length };
      return { nombre: a.nombre, veredicto: "aceptado", familia, expansion: z.descomprimidoTotal };
    }
    case "png":
    case "jpeg": {
      const dim = dimensiones(a.bytes, familia);
      if (!dim) return { ...rechazo(a.nombre, familia, "imagen_malformada"), expansion: a.bytes.length };
      if (dim.w * dim.h > lim.maxPixeles) {
        return { ...rechazo(a.nombre, familia, "pixel_flood", `${dim.w}×${dim.h} px`), expansion: a.bytes.length };
      }
      return { nombre: a.nombre, veredicto: "aceptado", familia, expansion: a.bytes.length };
    }
    case "texto": {
      // XXE: siempre en .xml declarado; en .txt/.csv solo si el contenido sniff-ea
      // como XML (evita falsos positivos en un CSV que traiga "<!ENTITY" como dato).
      if (ext === "xml" || pareceXml(a.bytes)) {
        const xxe = escanearXxe(a.bytes);
        if (xxe) return { ...rechazo(a.nombre, familia, xxe, "DOCTYPE/ENTITY/XInclude"), expansion: a.bytes.length };
      }
      return { nombre: a.nombre, veredicto: "aceptado", familia, expansion: a.bytes.length };
    }
    case "pdf":
    case "ole":
      // Tamaño y magic OK; el parseo profundo (texto/celdas) ocurre en el sandbox,
      // "parsear nunca ejecutar" (docs/11 §4). El gate no abre el binario.
      return { nombre: a.nombre, veredicto: "aceptado", familia, expansion: a.bytes.length };
    default:
      // Desconocida y no pudo clasificarse → cuarentena, nunca se inventa.
      return { nombre: a.nombre, veredicto: "a_revisar", familia: "desconocida", motivo: "ilegible", expansion: a.bytes.length };
  }
}

const PEOR: Record<Veredicto, number> = { aceptado: 0, a_revisar: 1, rechazado: 2 };

/** El sobre del lote (docs/11 §4bis): número de archivos, tamaño crudo total, y
 *  descompresión AGREGADA (60 archivos "chicos" pueden sumar una bomba). El ruteo
 *  por-archivo no exime del tope agregado. */
export function validarLote(archivos: Archivo[], lim: Limites = LIMITES): ResultadoLote {
  if (archivos.length === 0) {
    return { veredicto: "rechazado", motivo: "vacio", detalle: "lote sin archivos", archivos: [] };
  }
  if (archivos.length > lim.lote.maxArchivos) {
    return { veredicto: "rechazado", motivo: "lote_excede_archivos", detalle: `${archivos.length} archivos`, archivos: [] };
  }
  const bytesTotal = archivos.reduce((s, a) => s + a.bytes.length, 0);
  if (bytesTotal > lim.lote.maxBytesTotal) {
    return { veredicto: "rechazado", motivo: "lote_excede_tamano", detalle: `${bytesTotal} bytes`, archivos: [] };
  }

  const resultados = archivos.map((a) => validarArchivo(a, lim));
  const expansionTotal = resultados.reduce((s, r) => s + r.expansion, 0);
  const archivosLimpios: ResultadoArchivo[] = resultados.map(({ expansion: _e, ...r }) => r);

  if (expansionTotal > lim.lote.maxDescomprimidoTotal) {
    return {
      veredicto: "rechazado",
      motivo: "lote_excede_descomprimido",
      detalle: `el lote expande a ${expansionTotal} bytes`,
      archivos: archivosLimpios,
    };
  }

  const veredicto = archivosLimpios.reduce<Veredicto>((peor, r) => (PEOR[r.veredicto] > PEOR[peor] ? r.veredicto : peor), "aceptado");
  return { veredicto, archivos: archivosLimpios };
}
