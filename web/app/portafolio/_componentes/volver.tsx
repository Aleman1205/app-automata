import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// Link de regreso en mono pequeña, con la flecha que se desliza al hover.
export function Volver({
  href,
  children = "Volver al portafolio",
}: {
  href: string;
  children?: string;
}) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-sepia transition-colors duration-300 hover:text-tinta"
    >
      <ArrowLeft
        className="size-3.5 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-x-1"
        strokeWidth={2.5}
      />
      {children}
    </Link>
  );
}
