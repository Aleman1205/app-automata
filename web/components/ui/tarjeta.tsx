"use client";

import { useRef } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";

// Tarjeta base del sistema. `interactiva` = se eleva al pasar el mouse.
// `tilt` = inclinación 3D sutil que sigue al cursor (animshelf: Tilt Card).
export function Tarjeta({
  children,
  interactiva = false,
  tilt = false,
  className = "",
  onClick,
}: {
  children: React.ReactNode;
  interactiva?: boolean;
  tilt?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.5);
  const rx = useSpring(useTransform(my, [0, 1], [3.5, -3.5]), {
    stiffness: 200,
    damping: 20,
  });
  const ry = useSpring(useTransform(mx, [0, 1], [-3.5, 3.5]), {
    stiffness: 200,
    damping: 20,
  });

  const base = `rounded-2xl border border-linea bg-hueso ${
    interactiva
      ? "cursor-pointer transition-shadow duration-300 hover:shadow-[0_24px_50px_-24px_rgba(29,23,16,0.28)]"
      : ""
  } ${className}`;

  if (tilt) {
    return (
      <motion.div
        ref={ref}
        className={base}
        style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
        onMouseMove={(e) => {
          const r = ref.current?.getBoundingClientRect();
          if (!r) return;
          mx.set((e.clientX - r.left) / r.width);
          my.set((e.clientY - r.top) / r.height);
        }}
        onMouseLeave={() => {
          mx.set(0.5);
          my.set(0.5);
        }}
        onClick={onClick}
      >
        {children}
      </motion.div>
    );
  }

  if (interactiva) {
    return (
      <motion.div
        whileHover={{ y: -4 }}
        transition={{ type: "spring", stiffness: 300, damping: 22 }}
        className={base}
        onClick={onClick}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <div className={base} onClick={onClick}>
      {children}
    </div>
  );
}
