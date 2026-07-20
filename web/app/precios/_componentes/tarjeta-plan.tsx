"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import type { Plan } from "@/lib/datos";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Boton } from "@/components/ui/boton";
import { Contador } from "@/components/motion/contador";
import type { Periodo } from "./toggle-periodo";

// Tarjeta de un plan. La destacada va en noche, ligeramente elevada y con el
// único botón acento de la página. El precio se re-monta con `key` al cambiar
// el periodo, así el Contador vuelve a animar hacia la cifra nueva.
export function TarjetaPlan({
  plan,
  periodo,
}: {
  plan: Plan;
  periodo: Periodo;
}) {
  const oscura = Boolean(plan.destacado);
  const precio = periodo === "anual" ? plan.precioAnual : plan.precioMes;

  return (
    <Tarjeta
      tilt
      className={`flex h-full flex-col p-8 ${
        oscura ? "border-noche bg-noche text-crema md:-translate-y-3" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={`font-mono text-xs uppercase tracking-[0.18em] ${
            oscura ? "text-crema/70" : "text-sepia"
          }`}
        >
          {plan.nombre}
        </span>
        {oscura && (
          <span className="rounded-full border border-crema/30 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-crema">
            Más elegido
          </span>
        )}
      </div>

      <div className="mt-6 flex items-baseline gap-2">
        <Contador
          key={periodo}
          valor={precio}
          formato="entero"
          prefijo="$"
          duracion={0.8}
          className="text-6xl font-black tracking-tight"
        />
        <span
          className={`text-sm font-medium ${
            oscura ? "text-crema/60" : "text-sepia"
          }`}
        >
          MXN /mes
        </span>
      </div>

      <div className="mt-2 h-4">
        <AnimatePresence mode="wait">
          {periodo === "anual" && (
            <motion.p
              key="nota-anual"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className={`font-mono text-[10px] uppercase tracking-[0.16em] ${
                oscura ? "text-crema/50" : "text-sepia"
              }`}
            >
              Facturado anual
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <p
        className={`mt-4 text-sm leading-relaxed ${
          oscura ? "text-crema/70" : "text-sepia"
        }`}
      >
        {plan.descripcion}
      </p>

      <div
        className={`my-6 border-t ${oscura ? "border-crema/15" : "border-linea"}`}
      />

      <ul className="space-y-3">
        {plan.rasgos.map((rasgo) => (
          <li
            key={rasgo}
            className="flex items-start gap-3 text-sm leading-relaxed"
          >
            <Check
              className={`mt-0.5 size-4 shrink-0 ${
                oscura ? "text-crema" : "text-oliva"
              }`}
              strokeWidth={2.5}
            />
            <span className={oscura ? "text-crema/85" : "text-tinta"}>
              {rasgo}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-8">
        {plan.destacado ? (
          <Boton variante="acento" icono="flecha" href="/nueva" className="w-full">
            Empezar con Pro
          </Boton>
        ) : (
          <Boton variante="oscuro" href="/nueva" className="w-full">
            {`Empezar con ${plan.nombre}`}
          </Boton>
        )}
      </div>
    </Tarjeta>
  );
}
