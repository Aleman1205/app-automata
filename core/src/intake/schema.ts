// ─────────────────────────────────────────────────────────────────────────────
// Esquema del intake (docs/10). El resultado de cada turno es una unión
// discriminada de 3 variantes: preguntar / cerrar / rechazar. La restricción
// por turno (§2) se impone ofreciendo distintas TOOLS al modelo, no por prompt:
//   turnos 1-2 → [preguntar, cerrar, rechazar]
//   turno 3    → [cerrar, rechazar]   (forzar cierre)
// ─────────────────────────────────────────────────────────────────────────────

// ── El spec (§4). Lo único que viaja aguas abajo. ──
export interface IntakeSpec {
  version: number;
  objetivo: string; // 20–500 chars
  entradas: { tipo: "archivo" | "texto" | "numero" | "fecha" | "seleccion"; formato: string | null; descripcion: string }[];
  salidas: { tipo: "archivo" | "pantalla"; formato: string; descripcion: string }[];
  reglas: string[]; // 0–15
  criterios_exito: { criterio: string; criterio_cliente: string }[]; // 2–10
  ambiguedades_restantes: string[];
  confianza: "alta" | "media" | "baja";
}

export interface Opcion {
  id: string;
  etiqueta: string;
  detalle: string;
  recomendada: boolean;
}

export interface Pregunta {
  id: string;
  titulo: string;
  opciones: Opcion[]; // 2–4
  permite_otro: boolean;
  pide_archivo: boolean;
}

export type Viabilidad = "viable" | "viable_con_reencuadre" | "fuera_de_alcance" | "no_procede";

export type TurnoResultado =
  | { accion: "preguntar"; viabilidad: "viable" | "viable_con_reencuadre"; reencuadre: string | null; preguntas: Pregunta[] }
  | { accion: "cerrar"; viabilidad: "viable" | "viable_con_reencuadre"; spec: IntakeSpec; saludo: string }
  | { accion: "rechazar"; viabilidad: "fuera_de_alcance" | "no_procede"; motivo_interno: string };

// La entrevista completa termina en cierre o rechazo, nunca en "preguntar".
export type Cierre = Extract<TurnoResultado, { accion: "cerrar" }>;
export type Rechazo = Extract<TurnoResultado, { accion: "rechazar" }>;
export type ResultadoIntake = Cierre | Rechazo;

// ── Respuestas del cliente (autoridad del servidor; el modelo no las inventa). ──
export interface RespuestaRonda {
  pregunta_id: string;
  opcion_id: string | null; // null si usó "otro"
  otro?: string; // ≤ 300 chars
}

// ── Definiciones de tools para el SDK (salida estructurada por turno). ──
// Se pasan como `tools` con tool_choice forzado; el input del tool ES la variante.

const OPCION_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    etiqueta: { type: "string" },
    detalle: { type: "string", description: "1 línea que aclara la opción, en lenguaje de negocio" },
    recomendada: { type: "boolean" },
  },
  required: ["id", "etiqueta", "detalle", "recomendada"],
} as const;

const SPEC_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "integer" },
    objetivo: { type: "string", minLength: 20, maxLength: 500 },
    entradas: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          tipo: { type: "string", enum: ["archivo", "texto", "numero", "fecha", "seleccion"] },
          formato: { type: ["string", "null"] },
          descripcion: { type: "string" },
        },
        required: ["tipo", "formato", "descripcion"],
      },
    },
    salidas: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          tipo: { type: "string", enum: ["archivo", "pantalla"] },
          formato: { type: "string" },
          descripcion: { type: "string" },
        },
        required: ["tipo", "formato", "descripcion"],
      },
    },
    reglas: { type: "array", maxItems: 15, items: { type: "string" } },
    criterios_exito: {
      type: "array",
      minItems: 2,
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          criterio: { type: "string", description: "Técnico, verificable; va al rubric del Verifier" },
          criterio_cliente: { type: "string", description: "Lenguaje natural; va a la aprobación" },
        },
        required: ["criterio", "criterio_cliente"],
      },
    },
    ambiguedades_restantes: { type: "array", items: { type: "string" } },
    confianza: { type: "string", enum: ["alta", "media", "baja"] },
  },
  required: ["version", "objetivo", "entradas", "salidas", "reglas", "criterios_exito", "ambiguedades_restantes", "confianza"],
} as const;

export const TOOL_PREGUNTAR = {
  name: "preguntar",
  description: "Faltan datos: haz 3–4 preguntas de NEGOCIO (nunca técnicas), de opción múltiple. Solo turnos 1–2.",
  input_schema: {
    type: "object",
    properties: {
      viabilidad: { type: "string", enum: ["viable", "viable_con_reencuadre"] },
      reencuadre: { type: ["string", "null"], description: "Si viable_con_reencuadre: la versión que SÍ hacemos hoy" },
      preguntas: {
        type: "array",
        minItems: 3,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            titulo: { type: "string", description: "Pregunta de negocio, sin jerga" },
            opciones: { type: "array", minItems: 2, maxItems: 4, items: OPCION_SCHEMA },
            permite_otro: { type: "boolean" },
            pide_archivo: { type: "boolean" },
          },
          required: ["id", "titulo", "opciones", "permite_otro", "pide_archivo"],
        },
      },
    },
    required: ["viabilidad", "reencuadre", "preguntas"],
  },
} as const;

export const TOOL_CERRAR = {
  name: "cerrar",
  description: "Ya hay suficiente para escribir el spec validado.",
  input_schema: {
    type: "object",
    properties: {
      viabilidad: { type: "string", enum: ["viable", "viable_con_reencuadre"] },
      spec: SPEC_SCHEMA,
      saludo: { type: "string", description: "Frase que abre la pantalla de aprobación" },
    },
    required: ["viabilidad", "spec", "saludo"],
  },
} as const;

export const TOOL_RECHAZAR = {
  name: "rechazar",
  description: "Esto no se construye (ilegal/dañino, o app con estado / integración esencial que ni reencuadrada cabe).",
  input_schema: {
    type: "object",
    properties: {
      viabilidad: { type: "string", enum: ["fuera_de_alcance", "no_procede"] },
      motivo_interno: { type: "string", description: "Para el registro; NUNCA se enseña al cliente" },
    },
    required: ["viabilidad", "motivo_interno"],
  },
} as const;

/** Tools disponibles por turno (impone la restricción del §2). */
export function toolsDelTurno(turno: number): unknown[] {
  return turno >= 3 ? [TOOL_CERRAR, TOOL_RECHAZAR] : [TOOL_PREGUNTAR, TOOL_CERRAR, TOOL_RECHAZAR];
}
