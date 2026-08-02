"use client";

import { useState } from "react";
import { aCsv } from "automata-core/salida/csv";
import type { Bloque, Seccion } from "@/lib/datos";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Metrica } from "@/components/ui/metrica";
import { Tabla } from "@/components/ui/tabla";
import { GraficaBarras } from "@/components/ui/grafica-barras";
import { GraficaLinea } from "@/components/ui/grafica-linea";
import { Ranking } from "@/components/ui/ranking";
import { Callout } from "@/components/ui/callout";
import { ResumenResultado } from "@/components/ui/resumen-resultado";
import { Comparacion } from "@/components/ui/comparacion";
import { Reveal } from "@/components/motion/reveal";

// Renderiza un resultado con el ESQUELETO FIJO de cuatro secciones (core/src/types.ts:Seccion).
// Antes era una lista plana: el agente elegía el orden y cada automatización salía con una forma
// distinta. Un cliente que ya vio un reporte nuestro tenía que volver a aprender dónde está cada
// cosa. Ahora la forma la pone la plataforma y el agente solo aporta contenido — que es lo que
// hace el entregable reconocible, y por tanto vendible.

const ORDEN: Seccion[] = ["resumen", "detalle", "revisar", "parametros"];
const NOMBRE: Record<Seccion, string> = {
  resumen: "Resumen",
  detalle: "Detalle",
  revisar: "A revisar",
  parametros: "Parámetros",
};

// Una PESTAÑA POR TABLA dentro de 'detalle', igual que el .xlsx hace una hoja por tabla. Tenerlas
// apiladas en una sola pestaña y separadas en el archivo serían dos productos distintos — y en una
// conciliación (conciliados · en banco no en registro · en registro no en banco · diferencias) la
// pila obliga a scrollear cientos de filas para llegar a la siguiente. Cada tabla con título se
// vuelve su propia pestaña; lo que no es tabla, o no tiene título, se queda junto bajo "Detalle".
interface Grupo { clave: string; nombre: string; bloques: Bloque[]; seccion: Seccion }

function agrupar(bloques: Bloque[]): Grupo[] {
  const grupos: Grupo[] = [];
  for (const seccion of ORDEN) {
    const dela = bloques.filter((b) => (b.seccion ?? "detalle") === seccion);
    if (dela.length === 0) continue;
    if (seccion !== "detalle") {
      grupos.push({ clave: seccion, nombre: NOMBRE[seccion], bloques: dela, seccion });
      continue;
    }
    const conTitulo = dela.filter((b) => b.tipo === "tabla" && b.titulo);
    const resto = dela.filter((b) => !(b.tipo === "tabla" && b.titulo));
    if (resto.length) grupos.push({ clave: "detalle", nombre: NOMBRE.detalle, bloques: resto, seccion });
    conTitulo.forEach((b, i) => {
      grupos.push({ clave: `detalle-${i}`, nombre: (b as Extract<Bloque, { tipo: "tabla" }>).titulo!, bloques: [b], seccion });
    });
  }
  return grupos;
}

function ContenidoBloque({ bloque }: { bloque: Bloque }) {
  switch (bloque.tipo) {
    case "resumen":
      return <ResumenResultado texto={bloque.texto} />;

    case "metricas":
      return (
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4">
          {bloque.items.map((m) => (
            <Metrica
              key={m.etiqueta}
              etiqueta={m.etiqueta}
              valor={m.valor}
              formato={m.formato}
              sufijo={m.sufijo}
              nota={m.nota}
              tendencia={m.tendencia}
            />
          ))}
        </div>
      );

    case "callout":
      return <Callout tono={bloque.tono} titulo={bloque.titulo} texto={bloque.texto} />;

    case "barras":
      return (
        <div className="flex flex-col gap-5">
          <Etiqueta>{bloque.titulo}</Etiqueta>
          <GraficaBarras datos={bloque.datos} formato={bloque.formato} />
        </div>
      );

    case "linea":
      return (
        <div className="flex flex-col gap-5">
          <Etiqueta>{bloque.titulo}</Etiqueta>
          <GraficaLinea datos={bloque.datos} formato={bloque.formato} />
        </div>
      );

    case "ranking":
      return (
        <div className="flex flex-col gap-6">
          <Etiqueta>{bloque.titulo}</Etiqueta>
          <Ranking datos={bloque.datos} formato={bloque.formato} />
        </div>
      );

    case "tabla":
      return <TablaConDescarga bloque={bloque} />;

    case "comparacion":
      return (
        <div className="flex flex-col gap-5">
          <Etiqueta>{bloque.titulo}</Etiqueta>
          <Comparacion pasos={bloque.pasos} />
        </div>
      );
  }
}

/** Nombre de archivo a partir del título de la tabla: "En banco, no en registro" → "en-banco-no-en-registro.csv" */
function archivoDe(titulo: string | undefined): string {
  const base = (titulo ?? "detalle")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || "detalle"}.csv`;
}

// CADA tabla se descarga por separado. Antes había un solo botón que exportaba la PRIMERA tabla
// del resultado: en una conciliación —que trae conciliados, en-banco-no-en-registro,
// en-registro-no-en-banco y diferencias— el cliente se llevaba una de cuatro y ni se enteraba de
// que faltaban tres. El .csv es el formato que de verdad se re-importa a CONTPAQi/Aspel.
function TablaConDescarga({ bloque }: { bloque: Extract<Bloque, { tipo: "tabla" }> }) {
  const descargar = () => {
    // Vía `aCsv` del core y NO con un join a mano: los datos vienen del archivo que subió el
    // cliente, así que una celda como `=cmd|'/c calc'!A1` viajaría intacta hasta su Excel, que no
    // la mostraría — la EJECUTARÍA. `aCsv` la neutraliza (core/src/salida/csv.ts).
    const csv = aCsv(bloque.columnas.map((c) => ({ campo: c.campo, etiqueta: c.etiqueta })), bloque.filas);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const enlace = document.createElement("a");
    enlace.href = url;
    enlace.download = archivoDe(bloque.titulo);
    enlace.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {bloque.titulo ? <Etiqueta>{bloque.titulo}</Etiqueta> : <span />}
        <button
          type="button"
          onClick={descargar}
          className="rounded-full border border-linea px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-sepia transition-colors hover:bg-papel"
        >
          Descargar .csv
        </button>
      </div>
      <Tabla columnas={bloque.columnas} filas={bloque.filas} />
    </div>
  );
}

const SIN_DIVISOR = new Set(["resumen", "metricas", "callout"]);

/** Cuántas filas hay que revisar. Es el número que va en la pestaña: si hay excepciones, no puede
 *  pasar desapercibido que las hay. */
function pendientes(bloques: Bloque[]): number {
  return bloques.reduce((n, b) => n + (b.tipo === "tabla" ? b.filas.length : 0), 0);
}

export function Resultado({ bloques }: { bloques: Bloque[] }) {
  // Un bloque sin `seccion` cae en 'detalle': el resolver ya la asigna siempre, pero el front no
  // puede asumir que el dato viejo del prototipo (lib/datos.ts) la traiga.
  const grupos = agrupar(bloques);

  const [activa, setActiva] = useState<string>(grupos[0]?.clave ?? "resumen");
  const actual = grupos.find((g) => g.clave === activa) ?? grupos[0];

  // Con una sola pestaña sobran: serían una fila de chrome sin ninguna elección.
  const conPestanas = grupos.length > 1;

  return (
    <div className="flex flex-col gap-8">
      {conPestanas && (
        <div className="flex flex-wrap gap-1 border-b border-linea" role="tablist">
          {grupos.map((g) => {
            const n = g.seccion === "revisar" ? pendientes(g.bloques) : 0;
            const sel = g.clave === activa;
            return (
              <button
                key={g.clave}
                role="tab"
                aria-selected={sel}
                onClick={() => setActiva(g.clave)}
                className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors ${
                  sel ? "border-tinta text-tinta" : "border-transparent text-sepia hover:text-tinta"
                }`}
              >
                {g.nombre}
                {n > 0 && (
                  <span className="rounded-full bg-ambar/16 px-2 py-0.5 font-mono text-[10px] font-semibold text-ambar">
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-10">
        {(actual?.bloques ?? []).map((bloque, i) => (
          <Reveal
            key={`${activa}-${i}`}
            retraso={Math.min(i * 0.06, 0.3)}
            className={i > 0 && !SIN_DIVISOR.has(bloque.tipo) ? "border-t border-linea pt-10" : undefined}
          >
            <ContenidoBloque bloque={bloque} />
          </Reveal>
        ))}
      </div>
    </div>
  );
}
