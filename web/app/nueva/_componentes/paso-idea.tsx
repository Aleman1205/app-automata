"use client";

import { useState } from "react";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { MaquinaEscribir } from "@/components/motion/maquina-escribir";
import { ejemplosIdea } from "@/lib/datos";

const recortar = (texto: string, maximo = 60) =>
  texto.length > maximo ? `${texto.slice(0, maximo).trimEnd()}…` : texto;

// Paso 1: el usuario describe con sus palabras el proceso que quiere quitarse.
export function PasoIdea({
  texto,
  onCambiar,
  onContinuar,
}: {
  texto: string;
  onCambiar: (valor: string) => void;
  onContinuar: () => void;
}) {
  const [enfocado, setEnfocado] = useState(false);

  return (
    <div>
      <Reveal>
        <Etiqueta punto>PASO 1 — CUÉNTANOS</Etiqueta>
      </Reveal>

      <TextoRevelado
        como="h1"
        texto="¿Qué haces a mano que te roba tiempo?"
        className="mt-4 text-5xl leading-[0.95] font-black tracking-tight md:text-7xl"
        retraso={0.1}
      />

      <Reveal retraso={0.25} className="relative mt-10">
        <textarea
          value={texto}
          onChange={(e) => onCambiar(e.target.value)}
          onFocus={() => setEnfocado(true)}
          onBlur={() => setEnfocado(false)}
          aria-label="Describe el proceso que haces a mano"
          className="min-h-[220px] w-full resize-none rounded-2xl border border-linea bg-hueso p-6 text-lg text-tinta transition focus:border-tinta focus:outline-none"
        />
        {texto === "" && !enfocado && (
          <span className="pointer-events-none absolute inset-0 p-6 text-lg leading-relaxed text-sepia">
            <MaquinaEscribir frases={ejemplosIdea} />
          </span>
        )}
      </Reveal>

      <div className="mt-6 flex flex-wrap gap-3">
        {ejemplosIdea.map((ejemplo, i) => (
          <Reveal key={ejemplo} retraso={0.35 + i * 0.08} y={14}>
            <button
              type="button"
              onClick={() => onCambiar(ejemplo)}
              className="rounded-full border border-linea px-4 py-2 text-left text-sm text-sepia transition hover:border-tinta hover:text-tinta"
            >
              {recortar(ejemplo)}
            </button>
          </Reveal>
        ))}
      </div>

      <Reveal
        retraso={0.55}
        className="mt-12 flex flex-wrap items-center justify-between gap-4"
      >
        <Etiqueta>2 MINUTOS · SIN CONOCIMIENTOS TÉCNICOS</Etiqueta>
        <Boton
          variante="acento"
          icono="flecha"
          deshabilitado={!texto.trim()}
          onClick={onContinuar}
        >
          Continuar
        </Boton>
      </Reveal>
    </div>
  );
}
