"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";
import type { PuntoDato } from "@/lib/datos";

// Ranking: lista Top-N con barra proporcional. Una sola serie (tinta), como las
// gráficas del sistema. La barra crece al entrar en vista.

const fmt = (v: number, formato: "moneda" | "entero") =>
  formato === "moneda"
    ? new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: "MXN",
        maximumFractionDigits: 0,
      }).format(v)
    : new Intl.NumberFormat("es-MX").format(v);

export function Ranking({
  datos,
  formato = "moneda",
}: {
  datos: PuntoDato[];
  formato?: "moneda" | "entero";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const enVista = useInView(ref, { once: true, margin: "-40px" });
  const max = Math.max(...datos.map((d) => d.valor), 1);

  return (
    <div ref={ref} className="flex flex-col gap-4">
      {datos.map((d, i) => (
        <div key={d.etiqueta} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-4">
            <span className="flex items-center gap-2.5 text-sm font-medium">
              <span className="font-mono text-[11px] text-sepia tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              {d.etiqueta}
            </span>
            <span className="text-sm font-bold tabular-nums">
              {fmt(d.valor, formato)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-linea/60">
            <motion.div
              className="h-full rounded-full bg-tinta"
              initial={{ width: 0 }}
              animate={enVista ? { width: `${(d.valor / max) * 100}%` } : { width: 0 }}
              transition={{
                duration: 0.8,
                delay: i * 0.08,
                ease: [0.22, 1, 0.36, 1],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
