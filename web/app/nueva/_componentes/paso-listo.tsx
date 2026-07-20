"use client";

import { Boton } from "@/components/ui/boton";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { CheckDibujado } from "@/components/motion/check-dibujado";

// Cierre del flujo: confirmación de que los agentes ya están construyendo.
export function PasoListo() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
      <CheckDibujado tamano={96} />

      <TextoRevelado
        como="h2"
        texto="Manos a la obra."
        className="mt-8 text-3xl font-black tracking-tight md:text-5xl"
        retraso={0.35}
      />

      <Reveal retraso={0.55} className="mt-5 max-w-md">
        <p className="text-base leading-relaxed text-sepia md:text-lg">
          Un equipo de agentes ya está construyendo tu automatización. Te
          avisaremos por correo cuando esté lista — normalmente toma unos
          minutos.
        </p>
      </Reveal>

      <Reveal retraso={0.75} className="mt-10">
        <Boton variante="oscuro" icono="flecha" href="/portafolio">
          Ir a mi portafolio
        </Boton>
      </Reveal>
    </div>
  );
}
