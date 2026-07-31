// ─────────────────────────────────────────────────────────────────────────────
// Verificación del worker de validación de insumos (M4, docs/11 §4 + §4bis). Cada
// caso es un fixture HOSTIL. Los ZIP se construyen con DEFLATE REAL (node:zlib) para
// ejercitar la inflación acotada del gate, no un parser contra su propio escritor.
//   npm run verify:entrada
// ─────────────────────────────────────────────────────────────────────────────
import zlib from "node:zlib";
import { validarArchivo, validarLote } from "../src/entrada/validador.ts";
import { LIMITES, type Archivo, type Limites, type Motivo, type Veredicto } from "../src/entrada/tipos.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const f = (bytes: Buffer, extension: string, nombre = "x"): Archivo => ({ nombre, extension, bytes });

// ── Fixtures ─────────────────────────────────────────────────────────────────
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number, pad = false): Buffer {
  const head = pad ? [0xff, 0xd8, 0xff, 0xff, 0xc0] : [0xff, 0xd8, 0xff, 0xc0];
  const b = Buffer.alloc(head.length + 9);
  head.forEach((v, i) => (b[i] = v));
  const sof = head.length - 2; // índice del 0xFF del SOF
  b.writeUInt16BE(17, sof + 2); b[sof + 4] = 8; b.writeUInt16BE(h, sof + 5); b.writeUInt16BE(w, sof + 7);
  return b;
}
// ZIP con datos REALES (deflate por defecto, o stored). Central dir consistente.
function zip(entradas: { name: string; data: Buffer; metodo?: 0 | 8 }[]): Buffer {
  const partes: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entradas) {
    const metodo = e.metodo ?? 8;
    const comp = metodo === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const nb = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(nb.length, 26);
    partes.push(local, nb, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(metodo, 10);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nb.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nb);
    offset += local.length + nb.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entradas.length, 8); eocd.writeUInt16LE(entradas.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...partes, cd, eocd]);
}
const txt = (s: string) => Buffer.from(s, "utf8");
const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]);
const bin = Buffer.from([0x01, 0x02, 0x00, 0x03, 0x04, 0x05]);

const lim = (o: { maxBytesArchivo?: number; zip?: Partial<Limites["zip"]>; lote?: Partial<Limites["lote"]> }): Limites => ({
  maxBytesArchivo: o.maxBytesArchivo ?? LIMITES.maxBytesArchivo, maxPixeles: LIMITES.maxPixeles,
  zip: { ...LIMITES.zip, ...(o.zip ?? {}) }, lote: { ...LIMITES.lote, ...(o.lote ?? {}) },
});
const rech = (a: Archivo, motivo: Motivo, l?: Limites) => {
  const r = validarArchivo(a, l);
  if (r.veredicto !== "rechazado" || r.motivo !== motivo) console.log(`     (obtuve ${r.veredicto}/${r.motivo})`);
  return r.veredicto === "rechazado" && r.motivo === motivo;
};
const acepta = (a: Archivo, l?: Limites) => validarArchivo(a, l).veredicto === "aceptado";

console.log("1. Magic bytes vs extensión (spoofing):");
check("PNG válido → aceptado", acepta(f(png(64, 64), "png")));
check("JPEG válido (con relleno 0xFF) → aceptado", acepta(f(jpeg(64, 64, true), "jpg")));
check("ejecutable ELF renombrado a .csv → spoofing", rech(f(ELF, "csv"), "spoofing"));
check("PNG renombrado a .csv → spoofing", rech(f(png(8, 8), "csv"), "spoofing"));
check("PNG declarado .jpg → spoofing", rech(f(png(8, 8), "jpg"), "spoofing"));
check("extensión no permitida (.exe) → tipo_no_permitido", rech(f(bin, "exe"), "tipo_no_permitido"));
check("vacío → vacio", rech(f(Buffer.alloc(0), "csv"), "vacio"));
check("excede tamaño → excede_tamano", rech(f(Buffer.alloc(200), "csv"), "excede_tamano", lim({ maxBytesArchivo: 100 })));
check("FALSO POSITIVO evitado: CSV que empieza con 'MZ' → aceptado", acepta(f(txt("MZ,cantidad\n10,5\n"), "csv")));
check("FALSO POSITIVO evitado: CSV UTF-16 de Excel → aceptado", acepta(f(utf16("a,b\n1,2\n"), "csv")));

console.log("\n2. XXE / billion-laughs / XInclude (docs/11 §4bis):");
check("XML con <!DOCTYPE...<!ENTITY SYSTEM> → xxe", rech(f(txt('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>'), "xml"), "xxe"));
check("XXE SIN prólogo <?xml, declarado .txt → xxe (no se cuela)", rech(f(txt('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///x">]><r>&x;</r>'), "txt"), "xxe"));
check("XXE en UTF-16 (BOM) → xxe (latin1 ya no lo evade)", rech(f(utf16('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///x">]><r/>'), "xml"), "xxe"));
check("XInclude (sin DOCTYPE/ENTITY) → xxe", rech(f(txt('<?xml version="1.0"?><r xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd" parse="text"/></r>'), "xml"), "xxe"));
check("CFDI limpio → aceptado", acepta(f(txt('<?xml version="1.0"?><cfdi:Comprobante Total="100"/>'), "xml")));

console.log("\n3. ZIP: bomba REAL (inflación acotada), traversal, entradas (docs/11 §4bis):");
check("ZIP-bomb real (poco comprimido → mucho inflado) → zip_bomb", rech(
  f(zip([{ name: "a", data: Buffer.alloc(2_000_000) }]), "zip"), "zip_bomb", lim({ zip: { maxDescomprimido: 1_000_000 } })));
check("bomba 'stored' (comp=0 no ayuda) → zip_bomb", rech(
  f(zip([{ name: "a", data: Buffer.alloc(5000), metodo: 0 }]), "zip"), "zip_bomb", lim({ zip: { maxDescomprimido: 1000 } })));
check("ZIP con path traversal (../) → zip_traversal", rech(f(zip([{ name: "../../etc/passwd", data: txt("x") }]), "zip"), "zip_traversal"));
check("ZIP con ruta UNC (\\\\srv) → zip_traversal", rech(f(zip([{ name: "\\\\srv\\share\\x", data: txt("x") }]), "zip"), "zip_traversal"));
check("ZIP con demasiadas entradas → zip_entradas", rech(
  f(zip([1, 2, 3].map((i) => ({ name: `f${i}`, data: txt("x") }))), "zip"), "zip_entradas", lim({ zip: { maxEntradas: 2 } })));
check("ZIP limpio de CFDIs → aceptado", acepta(f(zip([{ name: "c1.xml", data: txt("<c/>") }, { name: "c2.xml", data: txt("<c/>") }]), "zip")));
check("BYPASS CERRADO: XXE dentro de un XLSX → xxe", rech(
  f(zip([{ name: "xl/sharedStrings.xml", data: txt('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><sst/>') }]), "xlsx"), "xxe"));
check("ZIP64 (tamaños 0xFFFFFFFF) → zip_corrupto (fuera de alcance)", (() => {
  const b = zip([{ name: "a", data: txt("x") }]);
  const cdOff = b.readUInt32LE(b.length - 22 + 16);
  b.writeUInt32LE(0xffffffff, cdOff + 24); // uncompSize declarado ZIP64
  return rech(f(b, "zip"), "zip_corrupto");
})());

console.log("\n4. Imágenes: pixel-flood / malformada / dim 0:");
check("PNG 20000×20000 (400 MP) → pixel_flood", rech(f(png(20000, 20000), "png"), "pixel_flood"));
check("JPEG 16000×16000 → pixel_flood", rech(f(jpeg(16000, 16000), "jpg"), "pixel_flood"));
check("JPEG con altura 0 (DNL) → imagen_malformada", rech(f(jpeg(1000, 0), "jpg"), "imagen_malformada"));
check("PNG con IHDR roto → imagen_malformada", rech(f((() => { const b = png(8, 8); b.write("XXXX", 12, "latin1"); return b; })(), "png"), "imagen_malformada"));
check("foto de celular 12000×9000 (108 MP) → aceptado (no falso positivo)", acepta(f(jpeg(12000, 9000), "jpg")));

console.log("\n5. Ilegible → cuarentena (NUNCA se inventa):");
const rIleg = validarArchivo(f(bin, "txt"));
check("binario ilegible declarado .txt → a_revisar / ilegible", rIleg.veredicto === "a_revisar" && rIleg.motivo === "ilegible");
check("CSV de texto plano → aceptado", acepta(f(txt("a,b,c\n1,2,3\n"), "csv")));

console.log("\n6. Sobre de LOTE agregado (docs/11 §4bis):");
const csv = () => f(txt("a,b\n1,2\n"), "csv");
check("lote vacío → rechazado (ya no pasa como aceptado)", validarLote([]).veredicto === "rechazado");
check("lote con demasiados archivos → lote_excede_archivos", validarLote([csv(), csv(), csv()], lim({ lote: { maxArchivos: 2 } })).motivo === "lote_excede_archivos");
check("lote con tamaño total excesivo → lote_excede_tamano", validarLote([f(Buffer.alloc(80), "csv"), f(Buffer.alloc(80), "csv")], lim({ lote: { maxBytesTotal: 100 } })).motivo === "lote_excede_tamano");
check("ZIPs que SUMAN una bomba → lote_excede_descomprimido", validarLote(
  [f(zip([{ name: "a", data: Buffer.alloc(400_000) }]), "zip"), f(zip([{ name: "b", data: Buffer.alloc(400_000) }]), "zip")],
  lim({ lote: { maxDescomprimidoTotal: 500_000 } })).motivo === "lote_excede_descomprimido");
const loteLimpio = validarLote([csv(), csv()]);
check("lote limpio → aceptado", loteLimpio.veredicto === "aceptado" && loteLimpio.archivos.length === 2);
const loteMalo = validarLote([csv(), f(txt('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///x">]><r/>'), "xml")]);
check("lote con un hostil → rechazado (el peor manda), con detalle por-archivo", loteMalo.veredicto === "rechazado" && loteMalo.archivos.some((a) => a.motivo === "xxe"));
check("lote con un ilegible → a_revisar", validarLote([csv(), f(bin, "txt")]).veredicto === "a_revisar");

console.log("\n7. Los límites POR DEFECTO (los que corren en producción):");
// Todos los casos de arriba INYECTAN límites pequeños (`lim({...})`), así que prueban que el gate
// SABE bloquear — pero no que ESTÉ CONFIGURADO para bloquear. Una auditoría por mutación lo
// demostró: poniendo maxEntradas a 10 millones, maxDescomprimido a 900 GB o maxArchivos a 10
// millones, TODA la suite seguía en verde. En producción se usan los defaults
// (`gatearArchivoBytes(...)` los toma de LIMITES), o sea que se podía desarmar la defensa contra
// zip-bombs y subidas gigantes sin que un solo test se quejara.
//
// Se comprueban dos cosas distintas: (a) que los defaults sigan en un rango sensato, y (b) el
// comportamiento REAL sin inyectar nada — que es lo que de verdad corre.
check(`maxBytesArchivo por defecto es sensato (${(LIMITES.maxBytesArchivo / 1024 / 1024).toFixed(0)} MB)`,
  LIMITES.maxBytesArchivo > 0 && LIMITES.maxBytesArchivo <= 100 * 1024 * 1024);
check(`maxPixeles por defecto es sensato (${(LIMITES.maxPixeles / 1e6).toFixed(0)} MP)`,
  LIMITES.maxPixeles > 0 && LIMITES.maxPixeles <= 500_000_000);
check(`zip.maxEntradas por defecto es sensato (${LIMITES.zip.maxEntradas})`,
  LIMITES.zip.maxEntradas > 0 && LIMITES.zip.maxEntradas <= 10_000);
check(`zip.maxDescomprimido por defecto es sensato (${(LIMITES.zip.maxDescomprimido / 1024 / 1024).toFixed(0)} MB)`,
  LIMITES.zip.maxDescomprimido > 0 && LIMITES.zip.maxDescomprimido <= 1024 * 1024 * 1024);
check(`lote.maxArchivos por defecto es sensato (${LIMITES.lote.maxArchivos})`,
  LIMITES.lote.maxArchivos > 0 && LIMITES.lote.maxArchivos <= 500);
check(`lote.maxBytesTotal por defecto es sensato (${(LIMITES.lote.maxBytesTotal / 1024 / 1024).toFixed(0)} MB)`,
  LIMITES.lote.maxBytesTotal > 0 && LIMITES.lote.maxBytesTotal <= 1024 * 1024 * 1024);

// Y el comportamiento con los defaults, SIN inyectar: un ZIP con más entradas de las permitidas se
// rechaza de verdad. Es la prueba de que el número no es decorativo.
const demasiadas = Array.from({ length: LIMITES.zip.maxEntradas + 1 }, (_, i) => ({ name: `f${i}.csv`, data: txt("a,b\n1,2\n") }));
check("ZIP con más entradas que el default → rechazado SIN inyectar límites", rech(f(zip(demasiadas), "zip"), "zip_entradas"));
const loteGrande = Array.from({ length: LIMITES.lote.maxArchivos + 1 }, () => csv());
check("lote con más archivos que el default → rechazado SIN inyectar límites", validarLote(loteGrande).veredicto === "rechazado");

console.log(`\n${ok ? "✓ M4 (validación de insumos hostiles) PROBADO" : "✗ FALLÓ"} — inflación acotada, XXE-en-xlsx, spoofing, pixel-flood, lote.`);
process.exit(ok ? 0 : 1);
