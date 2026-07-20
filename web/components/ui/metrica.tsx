import { Contador } from "@/components/motion/contador";

// Cifra destacada con etiqueta mono y conteo animado.
export function Metrica({
  etiqueta,
  valor,
  formato = "entero",
  sufijo = "",
  nota,
}: {
  etiqueta: string;
  valor: number;
  formato?: "moneda" | "entero";
  sufijo?: string;
  nota?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-sepia">
        {etiqueta}
      </span>
      <span className="text-4xl font-black tracking-tight md:text-5xl">
        <Contador valor={valor} formato={formato} sufijo={sufijo} />
      </span>
      {nota && <span className="text-sm text-sepia">{nota}</span>}
    </div>
  );
}
