import { Contador } from "@/components/motion/contador";

// Cifra destacada con etiqueta mono y conteo animado. Puede llevar una nota
// (contexto) y/o una tendencia (comparación con un periodo anterior).
export function Metrica({
  etiqueta,
  valor,
  formato = "entero",
  sufijo = "",
  nota,
  tendencia,
}: {
  etiqueta: string;
  valor: number;
  formato?: "moneda" | "entero";
  sufijo?: string;
  nota?: string;
  tendencia?: string;
}) {
  // "+" al inicio → sube (oliva); "-" → baja (ladrillo); si no, neutro.
  const tono = tendencia?.trim().startsWith("+")
    ? "text-oliva"
    : tendencia?.trim().startsWith("-")
      ? "text-ladrillo"
      : "text-sepia";
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-sepia">
        {etiqueta}
      </span>
      <span className="text-4xl font-black tracking-tight md:text-5xl">
        <Contador valor={valor} formato={formato} sufijo={sufijo} />
      </span>
      {tendencia && (
        <span className={`font-mono text-[11px] font-semibold tracking-wide ${tono}`}>
          {tendencia}
        </span>
      )}
      {nota && <span className="text-sm text-sepia">{nota}</span>}
    </div>
  );
}
