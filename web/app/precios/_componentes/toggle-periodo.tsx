"use client";

import { motion } from "motion/react";

export type Periodo = "mensual" | "anual";

const opciones: { valor: Periodo; etiqueta: string }[] = [
  { valor: "mensual", etiqueta: "Mensual" },
  { valor: "anual", etiqueta: "Anual" },
];

// Segmento de píldora (ref. topbar): la píldora clara se desliza entre las
// dos opciones con un spring. Junto a "Anual", un chip mono con la promo.
export function TogglePeriodo({
  periodo,
  onCambio,
}: {
  periodo: Periodo;
  onCambio: (periodo: Periodo) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-noche p-1.5 shadow-lg shadow-noche/25">
      {opciones.map((opcion) => {
        const activa = periodo === opcion.valor;
        return (
          <button
            key={opcion.valor}
            type="button"
            onClick={() => onCambio(opcion.valor)}
            className="relative flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium"
          >
            {activa && (
              <motion.span
                layoutId="pildora-precios"
                className="absolute inset-0 rounded-full bg-hueso"
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
            <span
              className={`relative z-10 transition-colors duration-200 ${
                activa ? "text-noche" : "text-crema/70"
              }`}
            >
              {opcion.etiqueta}
            </span>
            {opcion.valor === "anual" && (
              <span
                className={`relative z-10 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors duration-200 ${
                  activa
                    ? "border-noche/25 text-noche/70"
                    : "border-crema/30 text-crema/60"
                }`}
              >
                2 meses gratis
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
