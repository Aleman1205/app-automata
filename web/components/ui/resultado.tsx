"use client";

import type { Bloque } from "@/lib/datos";
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

// Renderiza un resultado como una lista ordenada de BLOQUES. El agente elige qué
// bloques y en qué orden; este componente solo sabe pintarlos, de forma
// consistente y animada. Añadir un tipo de bloque = un case aquí.

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
      return (
        <div className="flex flex-col gap-5">
          {bloque.titulo && <Etiqueta>{bloque.titulo}</Etiqueta>}
          <Tabla columnas={bloque.columnas} filas={bloque.filas} />
        </div>
      );

    case "comparacion":
      return (
        <div className="flex flex-col gap-5">
          <Etiqueta>{bloque.titulo}</Etiqueta>
          <Comparacion pasos={bloque.pasos} />
        </div>
      );
  }
}

// Los bloques que "cierran" una fila visual llevan divisor arriba para separar
// secciones sin recargar. metricas/resumen/callout fluyen sin línea.
const SIN_DIVISOR = new Set(["resumen", "metricas", "callout"]);

export function Resultado({ bloques }: { bloques: Bloque[] }) {
  return (
    <div className="flex flex-col gap-10">
      {bloques.map((bloque, i) => (
        <Reveal
          key={i}
          retraso={Math.min(i * 0.06, 0.3)}
          className={
            i > 0 && !SIN_DIVISOR.has(bloque.tipo)
              ? "border-t border-linea pt-10"
              : undefined
          }
        >
          <ContenidoBloque bloque={bloque} />
        </Reveal>
      ))}
    </div>
  );
}
