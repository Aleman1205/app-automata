"use client";

import { Reveal } from "@/components/motion/reveal";
import { Etiqueta } from "@/components/ui/etiqueta";
import type { CambioVersion } from "@/lib/datos";

// Línea de tiempo vertical con las versiones de una automatización.
// Punto tinta = construcción original · punto sepia = ajuste.
export function TimelineCambios({
  cambios,
  conTitulo = true,
}: {
  cambios: CambioVersion[];
  conTitulo?: boolean;
}) {
  if (cambios.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      {conTitulo && <Etiqueta>Historial de cambios</Etiqueta>}
      <ol className="flex flex-col gap-7 border-l border-linea pl-7">
        {cambios.map((c, i) => (
          <li key={c.version} className="relative">
            <span
              aria-hidden
              className={`absolute -left-[33px] top-1 size-2.5 rounded-full ${
                c.tipo === "construccion" ? "bg-tinta" : "bg-sepia"
              }`}
            />
            <Reveal retraso={i * 0.08} y={14} desenfoque={false}>
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-sepia">
                  Versión {c.version} · {c.fecha}
                </span>
                <span className="text-sm font-semibold leading-snug">
                  {c.titulo}
                </span>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </div>
  );
}
