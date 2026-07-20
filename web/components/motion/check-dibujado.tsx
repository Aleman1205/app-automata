"use client";

import { motion } from "motion/react";

// Palomita que se dibuja a sí misma (animshelf: Checkmark Draw).
export function CheckDibujado({ tamano = 88 }: { tamano?: number }) {
  return (
    <svg width={tamano} height={tamano} viewBox="0 0 88 88" fill="none">
      <motion.circle
        cx="44"
        cy="44"
        r="40"
        stroke="var(--color-oliva)"
        strokeWidth="3"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7, ease: "easeInOut" }}
      />
      <motion.path
        d="M28 45 L40 57 L61 33"
        stroke="var(--color-oliva)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.45, delay: 0.55, ease: "easeOut" }}
      />
    </svg>
  );
}
