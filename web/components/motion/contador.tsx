"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useInView } from "motion/react";
import { moneda, porcentaje, entero } from "automata-core/vista/formato";

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
  formato?: "moneda" | "entero" | "porcentaje";
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

  // Mismo formateador que la tabla y el .xlsx (core/src/vista/formato.ts, probado en
  // verify:formato). Aquí también estaba redondeando el dinero a pesos enteros — y este es el
  // componente que pinta los KPI GRANDES del resumen, así que una diferencia de 37 centavos se
  // anunciaba como "$0" en la cifra más visible de la pantalla.
  const texto = formato === "moneda" ? moneda(n) : formato === "porcentaje" ? porcentaje(n) : entero(n);

  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {prefijo}
      {texto}
      {sufijo}
    </span>
  );
}
