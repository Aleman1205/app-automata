"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { DoorOpen, Infinity as Infinito, Sparkles, Wrench } from "lucide-react";
import { faq, planes } from "@/lib/datos";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Acordeon } from "@/components/ui/acordeon";
import { Contador } from "@/components/motion/contador";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { TogglePeriodo, type Periodo } from "./_componentes/toggle-periodo";
import { TarjetaPlan } from "./_componentes/tarjeta-plan";

const garantias: { Icono: LucideIcon; texto: string }[] = [
  { Icono: Infinito, texto: "Ejecuciones sin límite" },
  { Icono: Wrench, texto: "Reparaciones gratis siempre" },
  {
    Icono: DoorOpen,
    texto: "Cancela cuando quieras — 30 días para descargar todo",
  },
];

export default function Precios() {
  const [periodo, setPeriodo] = useState<Periodo>("mensual");

  return (
    <div className="mx-auto max-w-6xl px-6">
      {/* 1. Cabecera + 2. Toggle */}
      <section className="pt-36 text-center md:pt-44">
        <Reveal>
          <Etiqueta punto>Precios</Etiqueta>
        </Reveal>
        <TextoRevelado
          como="h1"
          texto="Un precio simple, sin sorpresas."
          retraso={0.1}
          className="mx-auto mt-6 max-w-3xl text-5xl font-black leading-[0.95] tracking-tight md:text-7xl"
        />
        <Reveal retraso={0.25}>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-sepia md:text-lg">
            Pagas por automatizaciones que funcionan. Las que fallan no cuentan,
            y repararlas nunca cuesta.
          </p>
        </Reveal>
        <Reveal retraso={0.35} className="mt-12 flex justify-center">
          <TogglePeriodo periodo={periodo} onCambio={setPeriodo} />
        </Reveal>
      </section>

      {/* 3. Planes */}
      <section className="py-24 md:py-32">
        <div className="grid gap-6 md:grid-cols-3">
          {planes.map((plan, i) => (
            <Reveal key={plan.id} retraso={i * 0.08} className="h-full">
              <TarjetaPlan plan={plan} periodo={periodo} />
            </Reveal>
          ))}
        </div>
      </section>

      {/* 4. Banner de pago único */}
      <section className="py-24 md:py-32">
        <Reveal>
          <Tarjeta className="bg-papel">
            <div className="flex flex-col items-start gap-6 p-8 md:flex-row md:items-center md:p-10">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-full border border-linea bg-hueso">
                <Sparkles className="size-5 text-tinta" strokeWidth={2} />
              </span>
              <p className="flex-1 text-base leading-relaxed md:text-lg">
                <span className="font-semibold">¿Primera vez?</span>{" "}
                <span className="text-sepia">
                  Estrena con una sola automatización por
                </span>{" "}
                <Contador
                  valor={15}
                  formato="entero"
                  prefijo="$"
                  className="font-semibold"
                />
                <span className="text-sepia">
                  , pago único. Si te convence — y te va a convencer — cualquier
                  plan te espera.
                </span>
              </p>
              <Boton
                variante="oscuro"
                icono="flecha"
                href="/nueva"
                className="shrink-0"
              >
                Probar con una
              </Boton>
            </div>
          </Tarjeta>
        </Reveal>
      </section>

      {/* 5. Garantías */}
      <section className="py-24 md:py-32">
        <div className="grid gap-8 md:grid-cols-3">
          {garantias.map((garantia, i) => (
            <Reveal key={garantia.texto} retraso={i * 0.08}>
              <div className="flex items-center gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-linea bg-hueso">
                  <garantia.Icono className="size-5 text-tinta" strokeWidth={2} />
                </span>
                <span className="text-sm font-medium leading-snug">
                  {garantia.texto}
                </span>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 6. Preguntas frecuentes */}
      <section className="py-24 md:py-32">
        <div className="mx-auto max-w-3xl">
          <TextoRevelado
            como="h2"
            texto="Preguntas que nos hacen seguido."
            className="text-3xl font-black tracking-tight md:text-5xl"
          />
          <Reveal retraso={0.15} className="mt-10">
            <Acordeon items={faq} />
          </Reveal>
        </div>
      </section>

      {/* 7. Cierre */}
      <section className="flex flex-col items-center gap-8 py-24 text-center md:py-32">
        <Reveal>
          <Etiqueta>Sin tarjeta para explorar</Etiqueta>
        </Reveal>
        <Reveal retraso={0.1}>
          <Boton
            variante="oscuro"
            tamano="lg"
            icono="flecha"
            href="/nueva"
            magnetico
          >
            Crear mi primera automatización
          </Boton>
        </Reveal>
      </section>
    </div>
  );
}
