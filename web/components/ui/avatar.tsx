// Avatar de iniciales. Fondo neutro variado por persona (nunca oliva/ladrillo,
// que son colores de estado). Tamaños sm/md/lg.
const FONDOS = ["bg-tinta", "bg-sepia", "bg-noche"];

export function Avatar({
  nombre,
  indice = 0,
  tamano = "md",
  anillo = false,
}: {
  nombre: string;
  indice?: number;
  tamano?: "sm" | "md" | "lg";
  anillo?: boolean;
}) {
  const iniciales = nombre
    .split(" ")
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

  const dims = {
    sm: "size-7 text-[10px]",
    md: "size-9 text-xs",
    lg: "size-12 text-sm",
  };

  return (
    <span
      title={nombre}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-crema ${
        FONDOS[indice % FONDOS.length]
      } ${dims[tamano]} ${anillo ? "ring-2 ring-hueso" : ""}`}
    >
      {iniciales}
    </span>
  );
}

// Grupo de avatares superpuestos (ref. avatar stack). Muestra hasta `max` y
// un "+N" si hay más.
export function GrupoAvatares({
  nombres,
  max = 4,
  tamano = "sm",
}: {
  nombres: string[];
  max?: number;
  tamano?: "sm" | "md";
}) {
  const visibles = nombres.slice(0, max);
  const resto = nombres.length - visibles.length;
  const solape = tamano === "sm" ? "-ml-2" : "-ml-2.5";

  return (
    <span className="flex items-center">
      {visibles.map((n, i) => (
        <span key={i} className={i === 0 ? "" : solape}>
          <Avatar nombre={n} indice={i} tamano={tamano} anillo />
        </span>
      ))}
      {resto > 0 && (
        <span
          className={`${solape} inline-flex ${
            tamano === "sm" ? "size-7 text-[10px]" : "size-9 text-xs"
          } items-center justify-center rounded-full bg-papel font-semibold text-sepia ring-2 ring-hueso`}
        >
          +{resto}
        </span>
      )}
    </span>
  );
}
