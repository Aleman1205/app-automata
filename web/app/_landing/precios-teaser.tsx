"use client";

import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Contador } from "@/components/motion/contador";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { planes } from "@/lib/datos";

// Adelanto de precios. Los planes van en pesos (MXN): el Contador usa formato
// entero con prefijo "$" y el "MXN" va aparte. Precios provisionales — el piso
// real lo fija el costo por build que revele el spike.
export function PreciosTeaser() {
  return (
    <section className="border-t border-linea py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <TextoRevelado
          como="h2"
          texto="Un precio simple."
          className="text-3xl font-black tracking-tight md:text-5xl"
        />

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {planes.map((plan, i) => (
            <Reveal key={plan.id} retraso={i * 0.08} className="h-full">
              <Tarjeta className="flex h-full flex-col p-8">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-lg font-bold">{plan.nombre}</span>
                  {plan.destacado && <Etiqueta>MÁS ELEGIDO</Etiqueta>}
                </div>
                <div className="mt-6 flex items-baseline gap-2">
                  <span className="text-5xl font-black tracking-tight">
                    <Contador
                      valor={plan.precioMes}
                      formato="entero"
                      prefijo="$"
                    />
                  </span>
                  <span className="font-mono text-[11px] tracking-[0.18em] text-sepia uppercase">
                    MXN / mes
                  </span>
                </div>
                <p className="mt-4 text-sm text-sepia">
                  {plan.espacios} automatizaciones
                </p>
              </Tarjeta>
            </Reveal>
          ))}
        </div>

        <Reveal retraso={0.3} className="mt-10 flex justify-center">
          <Boton variante="fantasma" icono="diagonal" href="/precios">
            Ver todos los detalles
          </Boton>
        </Reveal>
      </div>
    </section>
  );
}
