// ─────────────────────────────────────────────────────────────────────────────
// La sección PARÁMETROS: con qué reglas se produjo este resultado.
//
// Es lo que vuelve el reporte DEFENDIBLE. Cuando el contador pregunte "¿por qué esta partida
// quedó fuera?", la respuesta tiene que estar en el mismo entregable y no en la memoria de quien
// hizo la entrevista hace tres meses. También es lo que hace la corrida reproducible: dos
// ejecuciones con los mismos parámetros deben dar lo mismo, y sin verlos escritos nadie puede
// comprobarlo.
//
// Lo llena LA PLATAFORMA desde el spec del intake, no el agente. El spec es un dato nuestro —lo
// capturamos nosotros y lo guardamos en `automatizaciones.spec`—, así que pedirle al modelo que
// lo repita en la vista sería darle una oportunidad de contradecirlo.
// ─────────────────────────────────────────────────────────────────────────────
import type { Bloque, Spec } from "../types.ts";

export interface FilaParametro {
  etiqueta: string;
  valor: string;
}

/**
 * Aplana un Spec a filas legibles. Una fila POR REGLA y por criterio, no un párrafo con todas
 * juntas: así se pueden leer, filtrar y citar una por una — que es lo que hace alguien cuando
 * está discutiendo un número concreto del reporte.
 */
export function parametrosDeSpec(spec: Spec | undefined): FilaParametro[] {
  if (!spec) return [];
  const filas: FilaParametro[] = [];
  if (spec.objetivo?.trim()) filas.push({ etiqueta: "Qué hace", valor: spec.objetivo.trim() });
  spec.reglas?.forEach((r, i) => {
    if (r?.trim()) filas.push({ etiqueta: `Regla ${i + 1}`, valor: r.trim() });
  });
  spec.criterios_exito?.forEach((c, i) => {
    if (c?.trim()) filas.push({ etiqueta: `Criterio ${i + 1}`, valor: c.trim() });
  });
  spec.entradas?.forEach((e, i) => {
    const partes = [e?.formato, e?.descripcion].filter((x) => x && String(x).trim());
    if (partes.length) filas.push({ etiqueta: `Insumo ${i + 1}`, valor: partes.join(" — ") });
  });
  return filas;
}

/**
 * El bloque de vista para la sección `parametros`. Devuelve null si no hay nada que mostrar: una
 * pestaña vacía es peor que no tenerla — promete información y no la da. (Distinto de `revisar`,
 * donde el vacío SÍ es información: "no hubo excepciones".)
 */
export function bloqueParametros(spec: Spec | undefined): Bloque | null {
  return bloqueDeParametros(parametrosDeSpec(spec));
}

/** Igual, pero desde las filas ya derivadas. El endpoint de detalle manda las FILAS (no el spec
 *  crudo), así que el front arma su bloque con esto y no vuelve a interpretar el spec por su
 *  cuenta — que es como las dos vistas empiezan a discrepar. */
export function bloqueDeParametros(filas: FilaParametro[]): Bloque | null {
  if (filas.length === 0) return null;
  return {
    seccion: "parametros",
    tipo: "tabla",
    titulo: "Con qué se produjo este resultado",
    columnas: [
      { campo: "etiqueta", etiqueta: "Parámetro" },
      { campo: "valor", etiqueta: "Valor" },
    ],
    filas: filas as unknown as Record<string, string | number>[],
  };
}
