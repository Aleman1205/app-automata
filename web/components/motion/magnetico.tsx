"use client";

import { useRef } from "react";
import { motion, useMotionValue, useSpring } from "motion/react";

// Envoltorio magnético: el contenido se inclina hacia el cursor (animshelf: Magnet).
export function Magnetico({
  children,
  fuerza = 0.25,
  className = "",
}: {
  children: React.ReactNode;
  fuerza?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 18 });
  const sy = useSpring(y, { stiffness: 220, damping: 18 });

  return (
    <motion.div
      ref={ref}
      style={{ x: sx, y: sy }}
      className={`inline-block ${className}`}
      onMouseMove={(e) => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        x.set((e.clientX - r.left - r.width / 2) * fuerza);
        y.set((e.clientY - r.top - r.height / 2) * fuerza);
      }}
      onMouseLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.div>
  );
}
