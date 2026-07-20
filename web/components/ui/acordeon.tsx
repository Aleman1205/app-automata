"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";

// Acordeón con altura animada y "+" que rota a "×" (animshelf: Accordion).
export function Acordeon({
  items,
}: {
  items: { pregunta: string; respuesta: string }[];
}) {
  const [abierto, setAbierto] = useState<number | null>(null);

  return (
    <div className="divide-y divide-linea border-y border-linea">
      {items.map((item, i) => {
        const activo = abierto === i;
        return (
          <div key={i}>
            <button
              onClick={() => setAbierto(activo ? null : i)}
              className="flex w-full items-center justify-between gap-4 py-5 text-left"
            >
              <span className="text-lg font-semibold">{item.pregunta}</span>
              <motion.span
                animate={{ rotate: activo ? 45 : 0 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="shrink-0"
              >
                <Plus className="size-5 text-sepia" />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {activo && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <p className="pb-6 pr-10 leading-relaxed text-sepia">
                    {item.respuesta}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
