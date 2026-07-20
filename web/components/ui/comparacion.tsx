"use client";

import { Fragment } from "react";
import { ArrowRight } from "lucide-react";
import { Contador } from "@/components/motion/contador";

// Comparación de flujo: entrada → resultados. Pensado para limpiezas y procesos
// donde importa "de cuánto partimos y en qué terminó". Tonos con la paleta de
// estados (oliva = bien, ladrillo = atención, neutro = informativo).

const COLOR = {
  ok: "text-oliva",
  alerta: "text-ladrillo",
  neutro: "text-tinta",
} as const;

export function Comparacion({
  pasos,
}: {
  pasos: { etiqueta: string; valor: number; tono?: "ok" | "alerta" | "neutro" }[];
}) {
  return (
    <div className="flex flex-col gap-6 rounded-2xl border border-linea bg-hueso p-6 sm:flex-row sm:items-center sm:justify-between md:p-8">
      {pasos.map((p, i) => (
        <Fragment key={p.etiqueta}>
          <div className="flex flex-col gap-1">
            <span className={`text-4xl font-black tracking-tight tabular-nums md:text-5xl ${COLOR[p.tono ?? "neutro"]}`}>
              <Contador valor={p.valor} formato="entero" />
            </span>
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-sepia">
              {p.etiqueta}
            </span>
          </div>
          {i < pasos.length - 1 && (
            <ArrowRight
              className="hidden size-6 shrink-0 text-linea sm:block"
              strokeWidth={2}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
