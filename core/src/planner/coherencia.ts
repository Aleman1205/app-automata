import type { Vista, VistaBloque } from "../types.ts";
import type { ResultadoContrato } from "./schema.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Puerta de coherencia (docs/09 §4): valida que TODA referencia @resultado.* de
// la vista esté respaldada por un campo del contrato del planner, CON EL TIPO
// correcto — escalar numero para valores de métrica/comparación, escalar texto
// para resumen/callout/notas, arreglo con campo 'numero' para el eje_y de las
// gráficas. Determinista, sin modelo, y NUNCA lanza: los bloques malformados se
// reportan como error (para que el planner reintente), no crashean el gate.
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
  const campos = new Map((contrato?.campos ?? []).map((c) => [c.ruta, c]));

  // Ref a un campo escalar del tipo esperado.
  const escalar = (ref: string, ctx: string, esperado: "numero" | "texto") => {
    const c = campos.get(ruta(ref));
    if (!c) e.push(`${ctx}: ${ref} no está en el contrato del resultado.`);
    else if (c.tipo === "arreglo") e.push(`${ctx}: ${ref} es un arreglo; se esperaba un valor escalar.`);
    else if (c.tipo !== esperado) e.push(`${ctx}: ${ref} es '${c.tipo}', se esperaba '${esperado}'.`);
  };

  // 'fuente' apunta a un arreglo; `existencia` deben existir; `numericos` deben ser numero.
  const arreglo = (fuente: unknown, ctx: string, existencia: unknown[], numericos: unknown[]) => {
    if (!esRef(fuente)) {
      e.push(`${ctx}: la fuente debe ser una referencia @resultado.*.`);
      return;
    }
    const c = campos.get(ruta(fuente));
    if (!c) return void e.push(`${ctx}: fuente ${fuente} no está en el contrato.`);
    if (c.tipo !== "arreglo") return void e.push(`${ctx}: fuente ${fuente} no es un arreglo en el contrato.`);
    const tipos = new Map((c.items ?? []).map((i) => [i.campo, i.tipo]));
    for (const campo of existencia) {
      if (typeof campo !== "string" || !tipos.has(campo)) e.push(`${ctx}: el arreglo ${fuente} no declara '${campo}'.`);
    }
    for (const campo of numericos) {
      if (typeof campo !== "string" || !tipos.has(campo)) e.push(`${ctx}: el arreglo ${fuente} no declara '${campo}'.`);
      else if (tipos.get(campo) !== "numero") e.push(`${ctx}: '${campo}' debe ser numero (es '${tipos.get(campo)}').`);
    }
  };

  for (const [i, b] of (vista?.bloques ?? ([] as VistaBloque[])).entries()) {
    const ctx = `bloque #${i + 1} (${b?.tipo ?? "?"})`;
    switch (b?.tipo) {
      case "resumen":
        if (esRef(b.texto)) escalar(b.texto, ctx, "texto");
        break;
      case "callout":
        if (esRef(b.titulo)) escalar(b.titulo, ctx, "texto");
        if (esRef(b.texto)) escalar(b.texto, ctx, "texto");
        break;
      case "metricas":
        if (!Array.isArray(b.items)) e.push(`${ctx}: falta 'items'.`);
        else
          for (const m of b.items) {
            if (esRef(m?.valor)) escalar(m.valor, `${ctx} "${m?.etiqueta}"`, "numero");
            for (const opt of [m?.sufijo, m?.nota, m?.tendencia]) if (esRef(opt)) escalar(opt, `${ctx} "${m?.etiqueta}"`, "texto");
          }
        break;
      case "barras":
      case "linea":
      case "ranking":
        arreglo(b.fuente, ctx, [b.eje_x], [b.eje_y]);
        break;
      case "tabla":
        if (!Array.isArray(b.columnas)) e.push(`${ctx}: falta 'columnas'.`);
        else arreglo(b.fuente, ctx, b.columnas.map((c) => c?.campo), []);
        break;
      case "comparacion":
        if (!Array.isArray(b.pasos)) e.push(`${ctx}: falta 'pasos'.`);
        else for (const p of b.pasos) if (esRef(p?.valor)) escalar(p.valor, `${ctx} "${p?.etiqueta}"`, "numero");
        break;
      default:
        // Alcanzable en runtime (el input del modelo es best-effort), aunque el
        // tipo lo marque exhaustivo: b es `never` aquí, así que se castea.
        e.push(`${ctx}: tipo de bloque desconocido '${(b as { tipo?: string })?.tipo}'.`);
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
  // El script es reutilizable: escribe en la carpeta que recibe por --salida
  // (NO una ruta fija). El RunExecutor busca ahí un resultado.json.
  return [
    "El script recibe la carpeta de salida como argumento --salida y DEBE escribir",
    "ahí un archivo llamado exactamente 'resultado.json' con EXACTAMENTE esta forma:",
    ...lineas,
  ].join("\n");
}
