"use client";

import { useRef } from "react";
import { useInView } from "motion/react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Gráfica de barras del sistema — SIEMPRE de una sola serie (barras en tinta).
// Nunca hagas gráficas multi-serie con la paleta de estados: no está validada
// como paleta categórica. Grid recesivo, extremos redondeados, tooltip propio.
// Se monta al entrar en vista para que la animación ocurra frente al usuario.

const fmtCompacto = (v: number, formato: "moneda" | "entero") =>
  formato === "moneda"
    ? new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: "MXN",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(v)
    : new Intl.NumberFormat("es-MX", { notation: "compact" }).format(v);

const fmtCompleto = (v: number, formato: "moneda" | "entero") =>
  formato === "moneda"
    ? new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: "MXN",
        maximumFractionDigits: 0,
      }).format(v)
    : new Intl.NumberFormat("es-MX").format(v);

function TooltipPropio({
  active,
  payload,
  label,
  formato,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
  formato: "moneda" | "entero";
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-linea bg-hueso px-4 py-2.5 shadow-lg shadow-tinta/10">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-sepia">
        {label}
      </p>
      <p className="mt-0.5 text-base font-bold tabular-nums">
        {fmtCompleto(payload[0].value, formato)}
      </p>
    </div>
  );
}

export function GraficaBarras({
  datos,
  formato = "moneda",
  alto = 300,
}: {
  datos: { etiqueta: string; valor: number }[];
  formato?: "moneda" | "entero";
  alto?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const enVista = useInView(ref, { once: true, margin: "-40px" });

  return (
    <div ref={ref} style={{ height: alto }} className="w-full">
      {enVista && (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={datos}
            margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
            barCategoryGap="32%"
          >
            <CartesianGrid vertical={false} stroke="var(--color-linea)" />
            <XAxis
              dataKey="etiqueta"
              axisLine={false}
              tickLine={false}
              tick={{
                fill: "var(--color-sepia)",
                fontSize: 12,
                fontFamily: "var(--font-plex-mono)",
              }}
              dy={8}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={58}
              tick={{
                fill: "var(--color-sepia)",
                fontSize: 11,
                fontFamily: "var(--font-plex-mono)",
              }}
              tickFormatter={(v: number) => fmtCompacto(v, formato)}
            />
            <Tooltip
              cursor={{ fill: "rgba(29, 23, 16, 0.05)" }}
              content={<TooltipPropio formato={formato} />}
            />
            <Bar
              dataKey="valor"
              fill="var(--color-tinta)"
              radius={[4, 4, 0, 0]}
              maxBarSize={44}
              animationDuration={900}
              animationEasing="ease-out"
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
