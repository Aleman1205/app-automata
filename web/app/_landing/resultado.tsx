"use client";

import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Metrica } from "@/components/ui/metrica";
import { GraficaBarras } from "@/components/ui/grafica-barras";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { obtenerAutomatizacion } from "@/lib/datos";

// Adelanto real del producto: las mismas métricas y gráfica que se ven en
// /portafolio/reporte-ventas, con los mismos componentes del sistema.
export function Resultado() {
  const resultado = obtenerAutomatizacion("reporte-ventas")?.resultado;
  if (!resultado) return null;

  // Total vendido, Ventas procesadas y Ticket promedio.
  const metricas = [
    resultado.metricas[0],
    resultado.metricas[1],
    resultado.metricas[3],
  ];

  return (
    <section className="border-y border-linea bg-papel py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal desenfoque={false}>
          <Etiqueta>ASÍ SE VE EL RESULTADO</Etiqueta>
        </Reveal>
        <TextoRevelado
          como="h2"
          texto="Esto es lo que recibes."
          retraso={0.1}
          className="mt-4 text-3xl font-black tracking-tight md:text-5xl"
        />

        <Reveal retraso={0.2} className="mt-12">
          <Tarjeta className="p-8 md:p-12">
            <div className="grid gap-10 md:grid-cols-3">
              {metricas.map((m) => (
                <Metrica
                  key={m.etiqueta}
                  etiqueta={m.etiqueta}
                  valor={m.valor}
                  formato={m.formato}
                  nota={m.nota}
                />
              ))}
            </div>

            <div className="mt-10 border-t border-linea pt-10">
              <Etiqueta>{resultado.grafica.titulo}</Etiqueta>
              <div className="mt-6">
                <GraficaBarras
                  datos={resultado.grafica.datos}
                  formato={resultado.grafica.formato}
                  alto={280}
                />
              </div>
            </div>

            <div className="mt-10">
              <Boton
                variante="fantasma"
                icono="diagonal"
                href="/portafolio/reporte-ventas"
              >
                Ver el ejemplo completo
              </Boton>
            </div>
          </Tarjeta>
        </Reveal>
      </div>
    </section>
  );
}
