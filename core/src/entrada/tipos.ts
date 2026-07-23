// ─────────────────────────────────────────────────────────────────────────────
// Validación de insumos hostiles (M4, docs/11 §4 + §4bis). El worker que gatea TODO
// archivo antes de que toque al Builder o al runner. Principio: parsear solo lo
// justo (magic bytes, cabeceras, directorio del ZIP) para aplicar TOPES — NUNCA
// inflar ni decodificar el input (que es donde viven zip-bomb/pixel-flood). Así la
// validación es acotada y determinista; la contención por proceso (RAM/CPU/timeout)
// es defensa en profundidad para el PARSEO REAL que ocurre DESPUÉS del gate.
// ─────────────────────────────────────────────────────────────────────────────

// Extensiones permitidas (docs/10 §4): el resto se rechaza de entrada.
export const EXTENSIONES = ["csv", "xlsx", "xls", "pdf", "txt", "xml", "zip", "jpg", "jpeg", "png"] as const;
export type Extension = (typeof EXTENSIONES)[number];

// Familia estructural detectada por magic bytes (independiente de la extensión).
export type Familia = "png" | "jpeg" | "zip" | "pdf" | "ole" | "ejecutable" | "texto" | "desconocida";

export type Veredicto = "aceptado" | "a_revisar" | "rechazado";

// Por qué se rechazó (o se mandó a revisar). Estable para telemetría/UI.
export type Motivo =
  | "vacio"
  | "tipo_no_permitido"
  | "spoofing" // magic bytes no concuerdan con la extensión (o ejecutable disfrazado)
  | "excede_tamano"
  | "xxe" // DOCTYPE/ENTITY en XML (XXE / billion laughs)
  | "zip_entradas" // demasiadas entradas
  | "zip_bomb" // ratio o tamaño descomprimido excesivo
  | "zip_traversal" // nombre con ../ o ruta absoluta
  | "zip_corrupto"
  | "pixel_flood" // dimensiones × > tope
  | "imagen_malformada"
  | "lote_excede_archivos"
  | "lote_excede_tamano"
  | "lote_excede_descomprimido"
  | "ilegible"; // formato desconocido → cuarentena "a revisar", NUNCA se inventa

export interface Limites {
  maxBytesArchivo: number;
  maxPixeles: number;
  // El ZIP se INFLA de verdad con tope duro (no se confía en tamaños declarados);
  // por eso no hay maxRatio — el único tope real es maxDescomprimido (bytes inflados).
  zip: { maxEntradas: number; maxDescomprimido: number };
  lote: { maxArchivos: number; maxBytesTotal: number; maxDescomprimidoTotal: number };
}

// Defaults. Nota (revisión M4): 10 MB era el EJEMPLO de intake, no un SLA; un PDF
// escaneado multipágina o una foto de celular de 48–108 MP lo superan. Se suben y se
// pueden gatear por plan/tipo más adelante.
export const LIMITES: Limites = {
  maxBytesArchivo: 50 * 1024 * 1024, // 50 MB por archivo (PDF/foto reales caben)
  maxPixeles: 200_000_000, // 200 MP: un celular de 108 MP pasa; una pixel-flood declara miles
  zip: {
    maxEntradas: 2000, // un ZIP de 500 CFDIs es legítimo; 100k no
    maxDescomprimido: 200 * 1024 * 1024, // tope DURO de bytes inflados por ZIP (node:zlib)
  },
  lote: {
    maxArchivos: 60, // el sobre del RUN multi-input (docs/11 §4bis)
    maxBytesTotal: 200 * 1024 * 1024, // 200 MB de lote crudo
    maxDescomprimidoTotal: 500 * 1024 * 1024, // suma agregada de lo que expanden los ZIP
  },
};

export interface Archivo {
  nombre: string;
  extension: string; // la declarada (del nombre / content-type); se DESCONFÍA de ella
  bytes: Buffer;
}

export interface ResultadoArchivo {
  nombre: string;
  veredicto: Veredicto;
  familia: Familia;
  motivo?: Motivo;
  detalle?: string;
}

export interface ResultadoLote {
  veredicto: Veredicto;
  motivo?: Motivo; // motivo a nivel de sobre (excede archivos/tamaño/descomprimido)
  detalle?: string;
  archivos: ResultadoArchivo[];
}
