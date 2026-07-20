"use client";

import { Infinity as Infinito, ShieldCheck, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Reveal } from "@/components/motion/reveal";

const tarjetas: { Icono: LucideIcon; titulo: string; detalle: string }[] = [
  {
    Icono: ShieldCheck,
    titulo: "Tus datos, aislados",
    detalle: "Cada cliente vive separado; tus archivos son solo tuyos.",
  },
  {
    Icono: Wrench,
    titulo: "Reparaciones gratis",
    detalle:
      "Si algo deja de funcionar sin que tú cambiaras nada, lo arreglamos sin costo.",
  },
  {
    Icono: Infinito,
    titulo: "Ejecuciones sin límite",
    detalle: "Usa tus automatizaciones las veces que necesites.",
  },
];

export function Confianza() {
  return (
    <section className="py-24 md:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-6 md:grid-cols-3">
          {tarjetas.map(({ Icono, titulo, detalle }, i) => (
            <Reveal key={titulo} retraso={i * 0.08} className="h-full">
              <Tarjeta className="h-full p-8">
                <span className="flex size-12 items-center justify-center rounded-full border border-linea bg-papel">
                  <Icono className="size-5 text-tinta" strokeWidth={2} />
                </span>
                <h3 className="mt-6 text-xl font-bold">{titulo}</h3>
                <p className="mt-2 text-sm leading-relaxed text-sepia">
                  {detalle}
                </p>
              </Tarjeta>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
