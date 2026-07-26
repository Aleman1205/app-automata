import { promises as fs } from "node:fs";
import path from "node:path";
import { validarArchivo, validarLote } from "./validador.ts";
import { LIMITES, type Limites, type Archivo, type ResultadoArchivo, type Motivo } from "./tipos.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Puente ruta→gate (a4): el CHOKE-POINT que conecta el gate de validación de insumos
// (entrada/validador) con el build y el run. El gate ya existía y estaba probado, pero
// NINGÚN flujo lo invocaba: el ejemplo se subía a CMA y el input se pasaba a python SIN
// validar. Esto lo hace obligatorio.
//
// NO se inyecta como puerto de Deps a propósito: es un choke-point, no una dependencia
// intercambiable — inyectarlo lo volvería saltable. La EXTENSIÓN viene del META declarado
// (upload/spec/manifiesto); en M0, si no hay meta, se deriva del path (que conserva la
// extensión real). Se hace fs.stat ANTES de readFile: un archivo gigante se rechaza por
// tamaño SIN cargarlo a RAM.
// ─────────────────────────────────────────────────────────────────────────────

/** El archivo es hostil (culpa del archivo): zip-bomb, XXE, ejecutable disfrazado, etc. */
export class EntradaRechazada extends Error {
  constructor(public readonly motivo: Motivo | string, public readonly nombre: string, public readonly detalle?: string) {
    super(`Entrada rechazada (${motivo})${detalle ? `: ${detalle}` : ""} — ${nombre}`);
    this.name = "EntradaRechazada";
  }
}
/** El archivo es ilegible/desconocido: va a "a revisión". NUNCA se inventa (docs/09). */
export class EntradaEnRevision extends Error {
  constructor(public readonly nombre: string) {
    super(`Entrada ilegible — va a revisión (nunca se inventa): ${nombre}`);
    this.name = "EntradaEnRevision";
  }
}

export interface MetaEntrada {
  nombre?: string;
  extension?: string; // declarada (upload/spec/manifiesto). Si falta, se deriva del path (M0).
}

// Lee un archivo de forma ACOTADA para gatearlo: fs.stat ANTES de readFile (no carga a RAM
// un archivo gigante solo para rechazarlo). Construye el Archivo que el gate espera.
async function leerParaGate(ruta: string, meta: MetaEntrada | undefined, lim: Limites): Promise<Archivo> {
  const nombre = meta?.nombre ?? path.basename(ruta);
  let st;
  try {
    st = await fs.stat(ruta);
  } catch {
    throw new EntradaRechazada("tipo_no_permitido", nombre, "no se pudo leer la ruta");
  }
  if (!st.isFile()) throw new EntradaRechazada("tipo_no_permitido", nombre, "no es un archivo regular");
  if (st.size > lim.maxBytesArchivo) throw new EntradaRechazada("excede_tamano", nombre, `${st.size} bytes`);
  const bytes = await fs.readFile(ruta);
  const extension = (meta?.extension ?? path.extname(ruta).replace(/^\./, "")).toLowerCase();
  return { nombre, extension, bytes };
}

function exigirAceptado(r: ResultadoArchivo): void {
  if (r.veredicto === "rechazado") throw new EntradaRechazada(r.motivo ?? "rechazado", r.nombre, r.detalle);
  if (r.veredicto === "a_revisar") throw new EntradaEnRevision(r.nombre);
}

/** Gate del BUILD: valida el archivo de ejemplo antes de construir / subir a CMA. */
export async function gatearEjemplo(ruta: string, meta?: MetaEntrada, lim: Limites = LIMITES): Promise<void> {
  exigirAceptado(validarArchivo(await leerParaGate(ruta, meta, lim), lim));
}

/** Gate del RUN: valida el SOBRE agregado de insumos (docs/11 §4bis). Lanza al primer
 *  hostil o si el lote excede; a_revisar → EntradaEnRevision (no corre). En M0 todos los
 *  inputs son rutas de archivo; cuando existan inputs de texto/número se filtran por tipo. */
export async function gatearInputs(inputs: Record<string, string>, metas: Record<string, MetaEntrada> = {}, lim: Limites = LIMITES): Promise<void> {
  const archivos: Archivo[] = [];
  for (const [k, ruta] of Object.entries(inputs)) archivos.push(await leerParaGate(ruta, metas[k], lim));
  const r = validarLote(archivos, lim);
  if (r.veredicto === "rechazado") {
    const malo = r.archivos.find((x) => x.veredicto === "rechazado");
    throw new EntradaRechazada(r.motivo ?? malo?.motivo ?? "rechazado", malo?.nombre ?? "(lote)", r.detalle ?? malo?.detalle);
  }
  if (r.veredicto === "a_revisar") {
    throw new EntradaEnRevision(r.archivos.find((x) => x.veredicto === "a_revisar")?.nombre ?? "(lote)");
  }
}
