// Contador visual de ajustes: ● ● ○ — los rellenos son los DISPONIBLES.
export function PuntosAjustes({
  usados,
  total = 3,
  conTexto = true,
  tamano = "md",
}: {
  usados: number;
  total?: number;
  conTexto?: boolean;
  tamano?: "md" | "lg";
}) {
  const restantes = Math.max(0, total - usados);
  const dim = tamano === "lg" ? "size-2.5" : "size-1.5";
  return (
    <span className="inline-flex items-center gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`${dim} rounded-full ${
            i < restantes ? "bg-tinta" : "border border-sepia/50 bg-transparent"
          }`}
        />
      ))}
      {conTexto && (
        <span className="ml-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-sepia">
          {restantes} de {total} ajustes
        </span>
      )}
    </span>
  );
}
