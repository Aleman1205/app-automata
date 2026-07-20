"use client";

import { Etiqueta } from "@/components/ui/etiqueta";
import { Marquesina } from "@/components/motion/marquesina";
import { pasosMarquesina } from "@/lib/datos";

// Franja infinita con los pasos del producto. Cada elemento termina con su
// separador para que el empalme del bucle no se note.
export function MarquesinaPasos() {
  return (
    <div className="-mt-px border-y border-linea bg-papel py-4">
      <Marquesina duracion={30}>
        {pasosMarquesina.map((paso) => (
          <Etiqueta key={paso} className="text-sm!">
            <span>{paso}</span>
            <span aria-hidden className="mx-5 text-sepia/60">
              ✦
            </span>
          </Etiqueta>
        ))}
      </Marquesina>
    </div>
  );
}
