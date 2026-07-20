import { Lock } from "lucide-react";
import type { EstadoAuto } from "@/lib/datos";

// Estado de una automatización: siempre punto de color + texto
// (nunca color solo — accesibilidad).
const config: Record<EstadoAuto, { color: string; texto: string }> = {
  lista: { color: "bg-oliva", texto: "Lista" },
  generando: { color: "bg-sepia", texto: "Generando…" },
  fallo: { color: "bg-ladrillo", texto: "No se pudo" },
  congelada: { color: "bg-tinta", texto: "Definitiva" },
};

export function Estado({ estado }: { estado: EstadoAuto }) {
  const c = config[estado];
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-sepia">
      {estado === "congelada" ? (
        <Lock className="size-3" strokeWidth={2.5} />
      ) : (
        <span className="relative flex size-2">
          {estado === "generando" && (
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${c.color}`}
            />
          )}
          <span className={`relative inline-flex size-2 rounded-full ${c.color}`} />
        </span>
      )}
      {c.texto}
    </span>
  );
}
