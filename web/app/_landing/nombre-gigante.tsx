"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { MARCA } from "@/lib/marca";

// Franja con la marca gigante (ref. SYMBOLSTUDIO): recortada por abajo y con
// parallax horizontal sutil ligado al scroll.
export function NombreGigante() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const x = useTransform(scrollYProgress, [0, 1], ["4vw", "-4vw"]);

  return (
    <div
      ref={ref}
      aria-hidden
      className="overflow-hidden border-b border-linea select-none"
    >
      <motion.div style={{ x }} className="flex justify-center whitespace-nowrap">
        <span className="-mb-[0.26em] block text-[15vw] leading-none font-black tracking-[-0.04em] text-tinta uppercase">
          {MARCA}
        </span>
      </motion.div>
    </div>
  );
}
