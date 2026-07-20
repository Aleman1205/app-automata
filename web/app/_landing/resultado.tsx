"use client";

import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Metrica } from "@/components/ui/metrica";
import { GraficaLinea } from "@/components/ui/grafica-linea";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { obtenerAutomatizacion } from "@/lib/datos";

// Adelanto real del producto: los mismos bloques (métricas + tendencia) que se
// ven en /portafolio/reporte-ventas, con los mismos componentes del sistema.
export function Resultado() {
  const resultado = obtenerAutomatizacion("reporte-ventas")?.resultado;
  const bloqueMetricas = resultado?.bloques.find((b) => b.tipo === "metricas");
  const bloqueLinea = resultado?.bloques.find((b) => b.tipo === "linea");
  if (!bloqueMetricas || bloqueMetricas.tipo !== "metricas") return null;

  // Total vendido, Ventas procesadas y Ticket promedio.
  const metricas = [
    bloqueMetricas.items[0],
    bloqueMetricas.items[1],
    bloqueMetricas.items[3],
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
                  sufijo={m.sufijo}
                  nota={m.nota}
                  tendencia={m.tendencia}
                />
              ))}
            </div>

            {bloqueLinea && bloqueLinea.tipo === "linea" && (
              <div className="mt-10 border-t border-linea pt-10">
                <Etiqueta>{bloqueLinea.titulo}</Etiqueta>
                <div className="mt-6">
                  <GraficaLinea
                    datos={bloqueLinea.datos}
                    formato={bloqueLinea.formato}
                    alto={280}
                  />
                </div>
              </div>
            )}

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
