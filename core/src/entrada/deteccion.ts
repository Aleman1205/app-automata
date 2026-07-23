import zlib from "node:zlib";
import { type Familia, type Limites, type Motivo } from "./tipos.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Parsers de validación. Para ZIP se INFLA de verdad, pero ACOTADO (node:zlib con
// maxOutputLength): el directorio central declara tamaños que el atacante controla,
// así que el único tope real es descomprimir con un cap duro de bytes y abortar. Es
// la defensa que pide docs/11 §4bis, sin dependencias. Imágenes: dimensiones desde
// la cabecera (esas SÍ acotan la memoria del decoder). Todo determinista y acotado.
// ─────────────────────────────────────────────────────────────────────────────

const empieza = (b: Buffer, sig: number[], off = 0): boolean =>
  b.length >= off + sig.length && sig.every((v, i) => b[off + i] === v);

const tieneBOM = (b: Buffer): "utf8" | "utf16le" | "utf16be" | null => {
  if (empieza(b, [0xef, 0xbb, 0xbf])) return "utf8";
  if (empieza(b, [0xff, 0xfe])) return "utf16le";
  if (empieza(b, [0xfe, 0xff])) return "utf16be";
  return null;
};

// ¿El 'MZ' es realmente un PE (ejecutable) y no un texto que empieza con "MZ..."?
function esPE(b: Buffer): boolean {
  if (!empieza(b, [0x4d, 0x5a]) || b.length < 0x40) return false;
  const eLfanew = b.readUInt32LE(0x3c);
  return eLfanew + 4 <= b.length && b.readUInt32LE(eLfanew) === 0x00004550; // 'PE\0\0'
}

/** Familia estructural por magic bytes. Caza spoofing (ejecutable/imagen renombrada
 *  a .csv) sin fiarse de la extensión. */
export function detectarFamilia(b: Buffer): Familia {
  if (b.length === 0) return "desconocida";

  // Texto con BOM (incl. UTF-16 de "Texto Unicode" de Excel) → texto, no binario.
  if (tieneBOM(b)) return "texto";

  // Ejecutables reales (no scripts de texto — a esos nunca los ejecutamos).
  if (empieza(b, [0x7f, 0x45, 0x4c, 0x46])) return "ejecutable"; // ELF
  if (esPE(b)) return "ejecutable"; // PE (MZ + firma PE; 'MZ' solo NO basta)
  if (empieza(b, [0xfe, 0xed, 0xfa, 0xce]) || empieza(b, [0xfe, 0xed, 0xfa, 0xcf]) ||
      empieza(b, [0xce, 0xfa, 0xed, 0xfe]) || empieza(b, [0xcf, 0xfa, 0xed, 0xfe])) return "ejecutable"; // Mach-O BE/LE
  if (empieza(b, [0xca, 0xfe, 0xba, 0xbe]) || empieza(b, [0xbe, 0xba, 0xfe, 0xca])) return "ejecutable"; // Mach-O fat / class

  if (empieza(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (empieza(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (empieza(b, [0x50, 0x4b, 0x03, 0x04]) || empieza(b, [0x50, 0x4b, 0x05, 0x06]) || empieza(b, [0x50, 0x4b, 0x07, 0x08]))
    return "zip";
  if (empieza(b, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (empieza(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole"; // xls viejo (OLE2)

  // Texto: sin bytes de control binarios en el arranque (BOM ya se descartó arriba).
  const muestra = b.subarray(0, Math.min(b.length, 512));
  const binario = muestra.some((c) => c === 0 || c < 0x09 || (c > 0x0d && c < 0x20 && c !== 0x1b));
  return binario ? "desconocida" : "texto";
}

/** Decodifica bytes a string respetando el BOM (para escanear XXE en cualquier
 *  codificación, no solo latin1). */
function decodificar(b: Buffer): string {
  const bom = tieneBOM(b);
  if (bom === "utf8") return b.subarray(3).toString("utf8");
  if (bom === "utf16le") return b.subarray(2).toString("utf16le");
  if (bom === "utf16be") { const s = Buffer.from(b.subarray(2)); s.swap16(); return s.toString("utf16le"); }
  return b.toString("latin1");
}

/** Rechaza XXE / bomba de entidades / XInclude. Para leer un CFDI no se necesita
 *  DTD, entidades ni includes → su presencia es motivo de rechazo (docs/11 §4bis).
 *  Escanea en la codificación real (BOM), así UTF-16 no lo evade. */
export function escanearXxe(b: Buffer): Motivo | null {
  const t = decodificar(b);
  if (/<!DOCTYPE/i.test(t) || /<!ENTITY/i.test(t)) return "xxe";
  // XInclude: lectura de archivos / SSRF sin DTD ni entidades.
  if (/<[\w-]*:?include\b/i.test(t) && /XInclude/i.test(t)) return "xxe";
  return null;
}

/** ¿El contenido de texto sniff-ea como XML? (cualquier señal, no solo el prólogo). */
export function pareceXml(b: Buffer): boolean {
  const t = decodificar(b).slice(0, 256).trimStart();
  return /^<\?xml/i.test(t) || /^<!DOCTYPE/i.test(t) || /^<!ENTITY/i.test(t);
}

interface InfoZip {
  entradas: number;
  descomprimidoTotal: number;
  motivo?: Motivo;
  detalle?: string;
}

const traversal = (nombre: string): boolean =>
  nombre.includes("../") || nombre.includes("..\\") || nombre.startsWith("/") ||
  nombre.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(nombre) || nombre.split(/[/\\]/).includes("..");

/** Inspecciona el ZIP INFLANDO cada entrada con un tope duro de bytes (node:zlib
 *  maxOutputLength). No confía en los tamaños declarados. Caza bombas reales (aunque
 *  declaren cifras honestas), path traversal, exceso de entradas, y XXE dentro de las
 *  entradas XML (el vector del xlsx). Aborta al primer problema. */
export function inspeccionarZip(b: Buffer, lim: Limites["zip"]): InfoZip {
  const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 65536; i--) {
    if (b.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return { entradas: 0, descomprimidoTotal: 0, motivo: "zip_corrupto", detalle: "sin EOCD" };

  const totalEntradas = b.readUInt16LE(eocd + 10);
  if (totalEntradas === 0) return { entradas: 0, descomprimidoTotal: 0, motivo: "zip_corrupto", detalle: "cero entradas" };
  if (totalEntradas > lim.maxEntradas) return { entradas: totalEntradas, descomprimidoTotal: 0, motivo: "zip_entradas", detalle: `${totalEntradas}` };

  let off = b.readUInt32LE(eocd + 16);
  let total = 0;
  for (let i = 0; i < totalEntradas; i++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== CEN) {
      return { entradas: i, descomprimidoTotal: total, motivo: "zip_corrupto", detalle: "directorio central inconsistente" };
    }
    const metodo = b.readUInt16LE(off + 10);
    const compSize = b.readUInt32LE(off + 20);
    const uncompDecl = b.readUInt32LE(off + 24);
    const nLen = b.readUInt16LE(off + 28);
    const extra = b.readUInt16LE(off + 30);
    const comLen = b.readUInt16LE(off + 32);
    const localOff = b.readUInt32LE(off + 42);
    const nombre = b.toString("utf8", off + 46, off + 46 + nLen);
    off += 46 + nLen + extra + comLen;

    if (traversal(nombre)) return { entradas: totalEntradas, descomprimidoTotal: total, motivo: "zip_traversal", detalle: nombre };
    // ZIP64 (tamaños/offset = 0xFFFFFFFF) fuera del alcance del gate → cuarentena dura.
    if (compSize === 0xffffffff || uncompDecl === 0xffffffff || localOff === 0xffffffff) {
      return { entradas: totalEntradas, descomprimidoTotal: total, motivo: "zip_corrupto", detalle: "zip64 no soportado" };
    }
    // Localiza los datos reales vía la cabecera LOCAL (no se confía en los tamaños del central).
    if (localOff + 30 > b.length || b.readUInt32LE(localOff) !== LOC) {
      return { entradas: totalEntradas, descomprimidoTotal: total, motivo: "zip_corrupto", detalle: "cabecera local ausente" };
    }
    const lNombre = b.readUInt16LE(localOff + 26);
    const lExtra = b.readUInt16LE(localOff + 28);
    const ini = localOff + 30 + lNombre + lExtra;
    if (ini + compSize > b.length) return { entradas: totalEntradas, descomprimidoTotal: total, motivo: "zip_corrupto", detalle: "datos fuera de rango" };
    const datos = b.subarray(ini, ini + compSize);

    const presupuesto = lim.maxDescomprimido - total; // lo que queda antes de la bomba
    let contenido: Buffer;
    if (metodo === 0) {
      if (compSize > presupuesto) return { entradas: totalEntradas, descomprimidoTotal: total + compSize, motivo: "zip_bomb", detalle: `${nombre} stored ${compSize}B` };
      contenido = datos;
    } else if (metodo === 8) {
      try {
        contenido = zlib.inflateRawSync(datos, { maxOutputLength: presupuesto + 1 }); // +1 → abortar al TOCAR el tope
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "ERR_BUFFER_TOO_LARGE") return { entradas: totalEntradas, descomprimidoTotal: lim.maxDescomprimido, motivo: "zip_bomb", detalle: `${nombre} infla > ${lim.maxDescomprimido}B` };
        return { entradas: totalEntradas, descomprimidoTotal: total, motivo: "zip_corrupto", detalle: `${nombre} deflate inválido` };
      }
    } else {
      return { entradas: totalEntradas, descomprimidoTotal: total, motivo: "zip_corrupto", detalle: `método ${metodo} no soportado` };
    }
    total += contenido.length;
    if (total > lim.maxDescomprimido) return { entradas: totalEntradas, descomprimidoTotal: total, motivo: "zip_bomb", detalle: `descomprime a ${total}B` };

    // XXE dentro del contenedor (el vector del xlsx): escanea las entradas XML ya infladas.
    if (/\.(xml|rels)$/i.test(nombre) || pareceXml(contenido)) {
      if (escanearXxe(contenido)) return { entradas: totalEntradas, descomprimidoTotal: total, motivo: "xxe", detalle: `${nombre} con DOCTYPE/ENTITY` };
    }
  }
  return { entradas: totalEntradas, descomprimidoTotal: total };
}

/** Dimensiones de PNG/JPEG desde la CABECERA, sin decodificar. null si no se
 *  pueden determinar (malformada) o si son no-positivas (JPEG con DNL). */
export function dimensiones(b: Buffer, familia: "png" | "jpeg"): { w: number; h: number } | null {
  if (familia === "png") {
    if (b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return null;
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i + 1] === 0xff && i + 1 < b.length) i++; // consume relleno 0xFF
    const marker = b[i + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = b.readUInt16BE(i + 5), w = b.readUInt16BE(i + 7);
      return w > 0 && h > 0 ? { w, h } : null; // altura 0 (DNL) → indeterminada → malformada
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}
