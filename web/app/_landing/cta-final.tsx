"use client";

import { Boton } from "@/components/ui/boton";
import { Contador } from "@/components/motion/contador";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";

export function CtaFinal() {
  return (
    <section className="pb-24 md:pb-32">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <div className="rounded-3xl bg-noche px-8 py-20 text-center text-crema">
            <TextoRevelado
              como="h2"
              texto="Deja de hacerlo a mano."
              className="text-3xl font-black tracking-tight md:text-5xl"
            />
            <Reveal retraso={0.15}>
              <p className="mx-auto mt-5 max-w-md text-base leading-relaxed text-linea md:text-lg">
                Tu primera automatización por{" "}
                <Contador valor={15} formato="entero" prefijo="$" />. Sin
                suscripción, sin riesgo.
              </p>
            </Reveal>
            <Reveal retraso={0.25} className="mt-10 flex justify-center">
              {/* Variante oscura con borde hueso: el único botón acento visible
                  al final de la página es el del Pie, que hace lo mismo. */}
              <Boton
                variante="oscuro"
                tamano="lg"
                icono="flecha"
                href="/nueva"
                magnetico
                className="border border-hueso/30 hover:border-hueso/60"
              >
                Empezar ahora
              </Boton>
            </Reveal>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
