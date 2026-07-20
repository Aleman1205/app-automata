"use client";

import { motion } from "motion/react";

// Aparición al hacer scroll: sube + se desdifumina (animshelf: Scroll Reveal).
export function Reveal({
  children,
  retraso = 0,
  y = 28,
  desenfoque = true,
  className = "",
}: {
  children: React.ReactNode;
  retraso?: number;
  y?: number;
  desenfoque?: boolean;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y, filter: desenfoque ? "blur(6px)" : "none" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, delay: retraso, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
