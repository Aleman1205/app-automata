"use client";

import { Etiqueta } from "@/components/ui/etiqueta";
import { Reveal } from "@/components/motion/reveal";

const pasos = [
  {
    numero: "01",
    titulo: "Cuéntalo",
    detalle: "Describe tu proceso como se lo contarías a un empleado nuevo.",
  },
  {
    numero: "02",
    titulo: "Responde",
    detalle: "Unas cuantas preguntas sencillas, de tu negocio, no de tecnología.",
  },
  {
    numero: "03",
    titulo: "Espera",
    detalle: "Un equipo de agentes lo construye y lo prueba solo.",
  },
  {
    numero: "04",
    titulo: "Úsalo",
    detalle:
      "Aparece en tu portafolio, listo para ejecutarse las veces que quieras.",
  },
];

export function ComoFunciona() {
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <Etiqueta>CÓMO FUNCIONA</Etiqueta>
        </Reveal>
        <div className="mt-10 grid divide-y divide-linea border-y border-linea md:grid-cols-4 md:divide-x md:divide-y-0">
          {pasos.map((paso, i) => (
            <Reveal key={paso.numero} retraso={i * 0.08} className="p-8">
              <span className="font-mono text-4xl text-sepia md:text-5xl">
                {paso.numero}
              </span>
              <h3 className="mt-6 text-xl font-bold">{paso.titulo}</h3>
              <p className="mt-2 text-sm leading-relaxed text-sepia">
                {paso.detalle}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
