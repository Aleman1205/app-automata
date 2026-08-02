import type { Vista } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// El planner (docs/03 "spec → tareas + rubric", docs/09 "declara la vista").
// Produce DOS cosas acopladas:
//   · vista: cómo se presenta el resultado (bloques + refs @resultado.*).
//   · resultado_contrato: la forma del resultado.json que el Builder DEBE producir
//     para que las refs de la vista resuelvan. El planner dueña el contrato de
//     salida; el builder lo implementa; la puerta de calidad valida que cuadren.
// ─────────────────────────────────────────────────────────────────────────────

/** Un campo del resultado.json que el script debe producir. */
export interface CampoContrato {
  ruta: string; // "metricas.ingreso_total" o "familias" (arreglo)
  tipo: "numero" | "texto" | "arreglo";
  descripcion: string;
  // Si tipo === "arreglo": los campos de cada item (para gráficas/tablas).
  items?: { campo: string; tipo: "numero" | "texto" }[];
}

export interface ResultadoContrato {
  campos: CampoContrato[];
}

export interface PlanResultado {
  vista: Vista;
  resultado_contrato: ResultadoContrato;
}

/** Contexto extra cuando lo que se planea es una VERSIÓN > 1 (un ajuste), no una automatización
 *  nueva. Sin esto el planner solo ve el spec —que NO cambia con la petición del cliente— y
 *  devolvería exactamente la misma vista de la versión vigente: el cliente pide dos columnas
 *  nuevas y recibe el reporte de antes. Y tampoco sirve REUSAR la vista anterior tal cual: la
 *  petición cambia la FORMA del resultado, así que vista y contrato tienen que re-planearse
 *  juntos (el acoplamiento @resultado.* es el invariante de todo el sistema). */
export interface AjustePlan {
  peticion: string; // lo que el cliente escribió, literal
  vistaAnterior?: Vista; // la vista vigente: se EVOLUCIONA, no se reinventa
}

// ── Tool para la salida estructurada del planner ──
// La vista se describe suelta (tipo + campos posibles); la CORRECTITUD la imponen
// la puerta de coherencia (coherencia.ts) y el resolver (tipos), no este schema.

const REF = { type: "string", description: "Referencia @resultado.<ruta> o literal" } as const;

const BLOQUE_SCHEMA = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: ["resumen", "metricas", "callout", "barras", "linea", "ranking", "tabla", "comparacion"] },
    seccion: {
      type: "string",
      enum: ["resumen", "detalle", "revisar", "parametros"],
      description: "En qué pestaña del entregable va este bloque. El esqueleto es fijo y lo impone la plataforma.",
    },
    titulo: { type: "string" },
    texto: REF,
    tono: { type: "string", enum: ["info", "ok", "alerta"] },
    formato: { type: "string", enum: ["moneda", "entero"] },
    fuente: REF,
    eje_x: { type: "string" },
    eje_y: { type: "string" },
    limite: { type: "integer" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          etiqueta: { type: "string" },
          valor: REF,
          formato: { type: "string", enum: ["moneda", "entero"] },
          sufijo: { type: "string" },
          nota: { type: "string" },
          tendencia: { type: "string" },
        },
        required: ["etiqueta", "valor", "formato"],
      },
    },
    columnas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          campo: { type: "string" },
          etiqueta: { type: "string" },
          alinear: { type: "string", enum: ["izquierda", "derecha"] },
          formato: { type: "string", enum: ["moneda", "entero", "texto", "porcentaje", "estado"] },
        },
        required: ["campo", "etiqueta"],
      },
    },
    pasos: {
      type: "array",
      items: {
        type: "object",
        properties: { etiqueta: { type: "string" }, valor: REF, tono: { type: "string", enum: ["ok", "alerta", "neutro"] } },
        required: ["etiqueta", "valor"],
      },
    },
  },
  required: ["tipo"],
} as const;

const CAMPO_SCHEMA = {
  type: "object",
  properties: {
    ruta: { type: "string" },
    tipo: { type: "string", enum: ["numero", "texto", "arreglo"] },
    descripcion: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { campo: { type: "string" }, tipo: { type: "string", enum: ["numero", "texto"] } },
        required: ["campo", "tipo"],
      },
    },
  },
  required: ["ruta", "tipo", "descripcion"],
} as const;

export const TOOL_PLANEAR = {
  name: "planear",
  description:
    "Produce la vista (bloques + refs @resultado.*) y el contrato del resultado.json que el builder debe generar. TODA ref @resultado.* de la vista debe estar respaldada por un campo del contrato.",
  input_schema: {
    type: "object",
    properties: {
      vista: {
        type: "object",
        properties: {
          version_vista: { type: "integer" },
          titulo: { type: "string" },
          archivoSalida: { type: "string" },
          bloques: { type: "array", minItems: 1, items: BLOQUE_SCHEMA },
        },
        required: ["version_vista", "titulo", "archivoSalida", "bloques"],
      },
      resultado_contrato: {
        type: "object",
        properties: { campos: { type: "array", minItems: 1, items: CAMPO_SCHEMA } },
        required: ["campos"],
      },
    },
    required: ["vista", "resultado_contrato"],
  },
} as const;
