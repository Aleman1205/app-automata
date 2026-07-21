import type { Vista, VistaBloque } from "../types.ts";
import type { ResultadoContrato } from "./schema.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Puerta de coherencia (docs/09 §4): valida que TODA referencia @resultado.* de
// la vista esté respaldada por un campo del contrato del planner, con el tipo
// correcto (escalar para valores, arreglo para fuentes de gráficas/tablas, y sus
// campos de item para ejes/columnas). Determinista, sin modelo — atrapa el bug
// "@resultado.promedio que el script nunca produce" ANTES de construir.
// ─────────────────────────────────────────────────────────────────────────────

const PREFIJO = "@resultado.";
const esRef = (v: unknown): v is string => typeof v === "string" && v.startsWith(PREFIJO);
const ruta = (ref: string) => ref.slice(PREFIJO.length);

export interface Coherencia {
  ok: boolean;
  errores: string[];
}

export function validarCoherencia(vista: Vista, contrato: ResultadoContrato): Coherencia {
  const e: string[] = [];
  const campos = new Map(contrato.campos.map((c) => [c.ruta, c]));

  const escalar = (ref: string, ctx: string) => {
    const c = campos.get(ruta(ref));
    if (!c) e.push(`${ctx}: ${ref} no está en el contrato del resultado.`);
    else if (c.tipo === "arreglo") e.push(`${ctx}: ${ref} es un arreglo; se esperaba un valor escalar.`);
  };

  const arregloConCampos = (fuente: string, requeridos: string[], ctx: string) => {
    const c = campos.get(ruta(fuente));
    if (!c) {
      e.push(`${ctx}: fuente ${fuente} no está en el contrato.`);
      return;
    }
    if (c.tipo !== "arreglo") {
      e.push(`${ctx}: fuente ${fuente} no es un arreglo en el contrato.`);
      return;
    }
    const itemCampos = new Set((c.items ?? []).map((i) => i.campo));
    for (const campo of requeridos) {
      if (!itemCampos.has(campo)) e.push(`${ctx}: el arreglo ${fuente} no declara el campo '${campo}'.`);
    }
  };

  for (const [i, b] of (vista.bloques as VistaBloque[]).entries()) {
    const ctx = `bloque #${i + 1} (${b.tipo})`;
    switch (b.tipo) {
      case "resumen":
        if (esRef(b.texto)) escalar(b.texto, ctx);
        break;
      case "callout":
        if (esRef(b.titulo)) escalar(b.titulo, ctx);
        if (esRef(b.texto)) escalar(b.texto, ctx);
        break;
      case "metricas":
        for (const m of b.items) {
          if (esRef(m.valor)) escalar(m.valor, `${ctx} "${m.etiqueta}"`);
          for (const opt of [m.sufijo, m.nota, m.tendencia]) if (esRef(opt)) escalar(opt, `${ctx} "${m.etiqueta}"`);
        }
        break;
      case "barras":
      case "linea":
      case "ranking":
        arregloConCampos(b.fuente, [b.eje_x, b.eje_y], ctx);
        break;
      case "tabla":
        arregloConCampos(b.fuente, b.columnas.map((c) => c.campo), ctx);
        break;
      case "comparacion":
        for (const p of b.pasos) if (esRef(p.valor)) escalar(p.valor, `${ctx} "${p.etiqueta}"`);
        break;
    }
  }

  return { ok: e.length === 0, errores: e };
}

/** Describe el contrato en texto, para pasárselo al Builder como objetivo de salida. */
export function contratoATexto(contrato: ResultadoContrato): string {
  const lineas = contrato.campos.map((c) => {
    if (c.tipo === "arreglo") {
      const items = (c.items ?? []).map((i) => `${i.campo}:${i.tipo}`).join(", ");
      return `- ${c.ruta} (arreglo de objetos con: ${items}) — ${c.descripcion}`;
    }
    return `- ${c.ruta} (${c.tipo}) — ${c.descripcion}`;
  });
  return `El script DEBE escribir /out/resultado.json con EXACTAMENTE esta forma:\n${lineas.join("\n")}`;
}
