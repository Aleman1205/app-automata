"use client";

import { motion } from "motion/react";
import { Etiqueta } from "@/components/ui/etiqueta";

// Transición corta: tres puntos que rebotan en cascada mientras "leemos" la idea.
export function PasoPensando() {
  return (
    <div className="flex min-h-[45vh] flex-col items-center justify-center gap-8 text-center">
      <div className="flex items-end gap-2.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="size-2.5 rounded-full bg-tinta"
            animate={{ y: [0, -8, 0] }}
            transition={{
              duration: 0.85,
              repeat: Infinity,
              delay: i * 0.15,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>
      <Etiqueta>LEYENDO TU PROCESO…</Etiqueta>
    </div>
  );
}
