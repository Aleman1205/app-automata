"use client";

import { Check, FileCheck2, FileSpreadsheet } from "lucide-react";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { specResumen } from "@/lib/datos";

// Pantalla de aprobación: lo que la entrevista entendió, en lenguaje llano.
export function PasoResumen({
  onCorregir,
  onAprobar,
}: {
  onCorregir: () => void;
  onAprobar: () => void;
}) {
  return (
    <div>
      <Reveal>
        <Etiqueta punto>REVISA Y APRUEBA</Etiqueta>
      </Reveal>

      <TextoRevelado
        como="h2"
        texto="Esto es lo que vamos a construir."
        className="mt-4 text-3xl font-black tracking-tight md:text-5xl"
        retraso={0.1}
      />

      <div className="mt-10 flex flex-col gap-4">
        <Reveal retraso={0.15}>
          <Tarjeta className="p-6">
            <Etiqueta>OBJETIVO</Etiqueta>
            <p className="mt-3 text-base leading-relaxed text-tinta md:text-lg">
              {specResumen.objetivo}
            </p>
          </Tarjeta>
        </Reveal>

        <div className="grid gap-4 md:grid-cols-2">
          <Reveal retraso={0.23} className="h-full">
            <Tarjeta className="h-full p-6">
              <Etiqueta>VAS A SUBIR</Etiqueta>
              <ul className="mt-3 flex flex-col gap-2.5">
                {specResumen.entradas.map((entrada) => (
                  <li key={entrada} className="flex items-start gap-2.5">
                    <FileSpreadsheet
                      className="mt-0.5 size-4 shrink-0 text-sepia"
                      strokeWidth={1.75}
                    />
                    <span className="text-sm leading-relaxed text-tinta">
                      {entrada}
                    </span>
                  </li>
                ))}
              </ul>
            </Tarjeta>
          </Reveal>

          <Reveal retraso={0.31} className="h-full">
            <Tarjeta className="h-full p-6">
              <Etiqueta>VAS A RECIBIR</Etiqueta>
              <ul className="mt-3 flex flex-col gap-2.5">
                {specResumen.salidas.map((salida) => (
                  <li key={salida} className="flex items-start gap-2.5">
                    <FileCheck2
                      className="mt-0.5 size-4 shrink-0 text-sepia"
                      strokeWidth={1.75}
                    />
                    <span className="text-sm leading-relaxed text-tinta">
                      {salida}
                    </span>
                  </li>
                ))}
              </ul>
            </Tarjeta>
          </Reveal>
        </div>

        <Reveal retraso={0.39}>
          <Tarjeta className="p-6">
            <Etiqueta>REGLAS DE TU NEGOCIO</Etiqueta>
            <ul className="mt-3 flex flex-col gap-2.5">
              {specResumen.reglas.map((regla) => (
                <li key={regla} className="flex items-start gap-2.5">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-sepia" />
                  <span className="text-sm leading-relaxed text-tinta">
                    {regla}
                  </span>
                </li>
              ))}
            </ul>
          </Tarjeta>
        </Reveal>

        <Reveal retraso={0.47}>
          <div className="rounded-2xl border border-linea bg-papel p-6">
            <Etiqueta>LO DAREMOS POR BUENO CUANDO</Etiqueta>
            <ul className="mt-3 flex flex-col gap-2.5">
              {specResumen.criterios.map((criterio) => (
                <li key={criterio} className="flex items-start gap-2.5">
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-oliva"
                    strokeWidth={3}
                  />
                  <span className="text-sm leading-relaxed text-tinta">
                    {criterio}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>

      <Reveal retraso={0.55} className="mt-8">
        <Etiqueta>
          PODRÁS PEDIR HASTA 3 AJUSTES CUANDO ESTÉ LISTA · LAS REPARACIONES SON
          GRATIS
        </Etiqueta>
      </Reveal>

      <Reveal
        retraso={0.63}
        className="mt-8 flex flex-wrap items-center justify-between gap-4"
      >
        <Boton variante="fantasma" onClick={onCorregir}>
          Corregir mis respuestas
        </Boton>
        <Boton variante="acento" icono="check" onClick={onAprobar}>
          Aprobar y construir
        </Boton>
      </Reveal>
    </div>
  );
}
