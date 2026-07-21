import type {
  Bloque,
  ColumnaDemo,
  FilaDemo,
  MetricaDemo,
  PuntoDato,
  Ref,
  Resultado,
  Vista,
  VistaBloque,
} from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Resolver: aterriza una Vista (con referencias @resultado.*) sobre el
// resultado.json que produjo el Run, y emite un Resultado (bloques con datos).
// Es también la PUERTA DE CALIDAD de docs/09: si una referencia no existe o el
// tipo no cuadra, revienta con un mensaje claro en vez de entregar una vista rota.
// ─────────────────────────────────────────────────────────────────────────────

export class VistaError extends Error {}

const PREFIJO = "@resultado.";

function esRef(v: unknown): v is Ref {
  return typeof v === "string" && v.startsWith(PREFIJO);
}

/** Camino con puntos: "metricas.ingreso_total" dentro del resultado. */
function leerCamino(raiz: unknown, camino: string): unknown {
  let actual: unknown = raiz;
  for (const parte of camino.split(".")) {
    if (actual == null || typeof actual !== "object") {
      throw new VistaError(`Referencia @resultado.${camino}: '${parte}' no existe (el script no lo produjo).`);
    }
    actual = (actual as Record<string, unknown>)[parte];
  }
  return actual;
}

function resolverRef(resultado: unknown, ref: Ref): unknown {
  return leerCamino(resultado, ref.slice(PREFIJO.length));
}

/** Resuelve un valor que debe ser número (métricas, comparación). */
function resolverNumero(resultado: unknown, v: Ref | number, contexto: string): number {
  if (typeof v === "number") return v;
  const valor = resolverRef(resultado, v);
  if (typeof valor !== "number") {
    throw new VistaError(
      `${contexto}: la referencia ${v} resolvió a ${typeof valor} (${JSON.stringify(valor)?.slice(0, 40)}), se esperaba número.`,
    );
  }
  return valor;
}

/** Resuelve un valor que debe ser texto (resumen). */
function resolverTexto(resultado: unknown, v: Ref | string, contexto: string): string {
  if (!esRef(v)) return v;
  const valor = resolverRef(resultado, v);
  if (typeof valor !== "string") {
    throw new VistaError(`${contexto}: la referencia ${v} resolvió a ${typeof valor}, se esperaba texto.`);
  }
  return valor;
}

/** Resuelve una `fuente` que debe ser un arreglo de objetos. */
function resolverArreglo(resultado: unknown, fuente: Ref, contexto: string): Record<string, unknown>[] {
  const valor = resolverRef(resultado, fuente);
  if (!Array.isArray(valor)) {
    throw new VistaError(`${contexto}: la fuente ${fuente} resolvió a ${typeof valor}, se esperaba un arreglo.`);
  }
  return valor as Record<string, unknown>[];
}

function numeroDeCampo(item: Record<string, unknown>, campo: string, contexto: string): number {
  const v = item[campo];
  if (typeof v !== "number") {
    throw new VistaError(`${contexto}: el campo '${campo}' no es número en un item de la fuente.`);
  }
  return v;
}

function resolverBloque(resultado: unknown, b: VistaBloque): Bloque {
  switch (b.tipo) {
    case "resumen":
      return { tipo: "resumen", texto: resolverTexto(resultado, b.texto, "bloque resumen") };

    case "callout":
      return { tipo: "callout", tono: b.tono, titulo: b.titulo, texto: b.texto };

    case "metricas": {
      const items: MetricaDemo[] = b.items.map((m, i) => ({
        etiqueta: m.etiqueta,
        valor: resolverNumero(resultado, m.valor, `métrica #${i + 1} "${m.etiqueta}"`),
        formato: m.formato,
        sufijo: m.sufijo,
        nota: m.nota,
        tendencia: m.tendencia,
      }));
      return { tipo: "metricas", items };
    }

    case "barras":
    case "linea":
    case "ranking": {
      const arr = resolverArreglo(resultado, b.fuente, `bloque ${b.tipo} "${b.titulo}"`);
      const acotado = b.limite ? arr.slice(0, b.limite) : arr;
      const datos: PuntoDato[] = acotado.map((item) => {
        const etiqueta = item[b.eje_x];
        return {
          etiqueta: etiqueta == null ? "—" : String(etiqueta),
          valor: numeroDeCampo(item, b.eje_y, `bloque ${b.tipo} "${b.titulo}"`),
        };
      });
      return { tipo: b.tipo, titulo: b.titulo, formato: b.formato, datos };
    }

    case "tabla": {
      const arr = resolverArreglo(resultado, b.fuente, `tabla "${b.titulo ?? ""}"`);
      const acotado = b.limite ? arr.slice(0, b.limite) : arr;
      const columnas: ColumnaDemo[] = b.columnas;
      const filas: FilaDemo[] = acotado.map((item) => {
        const fila: FilaDemo = {};
        for (const col of columnas) {
          const v = item[col.campo];
          fila[col.campo] = typeof v === "number" || typeof v === "string" ? v : v == null ? "" : String(v);
        }
        return fila;
      });
      return { tipo: "tabla", titulo: b.titulo, columnas, filas };
    }

    case "comparacion": {
      const pasos = b.pasos.map((p, i) => ({
        etiqueta: p.etiqueta,
        valor: resolverNumero(resultado, p.valor, `paso #${i + 1} "${p.etiqueta}"`),
        tono: p.tono,
      }));
      return { tipo: "comparacion", titulo: b.titulo, pasos };
    }
  }
}

/**
 * Aterriza una vista sobre un resultado. Lanza VistaError si alguna referencia
 * no existe o el tipo no cuadra (la puerta de calidad de docs/09 §4).
 */
export function resolverVista(vista: Vista, resultado: unknown): Resultado {
  const bloques = vista.bloques.map((b) => resolverBloque(resultado, b));
  return { bloques, archivoSalida: vista.archivoSalida };
}
