"use client";

import { motion } from "motion/react";
import { Insignia } from "@/components/ui/insignia";

export interface Columna {
  campo: string;
  etiqueta: string;
  alinear?: "izquierda" | "derecha";
  formato?: "moneda" | "entero" | "texto" | "porcentaje" | "estado";
}

// Tabla del sistema: encabezado mono, filas que entran en cascada al hacer
// scroll (animshelf: Stagger Grid) y hover por fila.
export function Tabla({
  columnas,
  filas,
}: {
  columnas: Columna[];
  filas: Record<string, string | number>[];
}) {
  const fmt = (v: string | number, formato?: string) => {
    if (formato === "estado") return <Insignia texto={String(v)} />;
    if (typeof v !== "number") return v;
    if (formato === "moneda")
      return new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: "MXN",
        maximumFractionDigits: 0,
      }).format(v);
    if (formato === "porcentaje")
      return `${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 }).format(v)}%`;
    return new Intl.NumberFormat("es-MX").format(v);
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-linea">
            {columnas.map((c) => (
              <th
                key={c.campo}
                className={`py-3 pr-4 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-sepia ${
                  c.alinear === "derecha" ? "text-right" : "text-left"
                }`}
              >
                {c.etiqueta}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((fila, i) => (
            <motion.tr
              key={i}
              className="border-b border-linea/60 transition-colors duration-200 hover:bg-papel"
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-20px" }}
              transition={{
                duration: 0.4,
                delay: i * 0.05,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {columnas.map((c) => (
                <td
                  key={c.campo}
                  className={`py-3 pr-4 ${
                    c.alinear === "derecha"
                      ? "text-right tabular-nums"
                      : "text-left"
                  } ${c.formato === "moneda" ? "font-semibold" : ""}`}
                >
                  {fmt(fila[c.campo], c.formato)}
                </td>
              ))}
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
