// Micro-etiqueta en monoespaciada, mayúsculas y tracking amplio
// (estilo "TECH#05" / "SEE SHOWREEL" de las referencias).
export function Etiqueta({
  children,
  punto = false,
  className = "",
}: {
  children: React.ReactNode;
  punto?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-sepia ${className}`}
    >
      {punto && <span className="size-1.5 rounded-full bg-acento" />}
      {children}
    </span>
  );
}
