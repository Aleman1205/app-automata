"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useInView } from "motion/react";

// Número que cuenta hacia arriba al entrar en pantalla (animshelf: Count Up).
export function Contador({
  valor,
  formato = "entero",
  prefijo = "",
  sufijo = "",
  duracion = 1.4,
  className = "",
}: {
  valor: number;
  formato?: "moneda" | "entero";
  prefijo?: string;
  sufijo?: string;
  duracion?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const enVista = useInView(ref, { once: true, margin: "-40px" });
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!enVista) return;
    const control = animate(0, valor, {
      duration: duracion,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setN(v),
    });
    return () => control.stop();
  }, [enVista, valor, duracion]);

  const texto =
    formato === "moneda"
      ? new Intl.NumberFormat("es-MX", {
          style: "currency",
          currency: "MXN",
          maximumFractionDigits: 0,
        }).format(n)
      : new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 }).format(n);

  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {prefijo}
      {texto}
      {sufijo}
    </span>
  );
}
