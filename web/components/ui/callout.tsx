"use client";

import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

// Bloque de atención: destaca algo que el usuario debe notar (filas a revisar,
// exclusiones, un logro). Tono con la paleta de estados — nunca el acento.
const ESTILOS = {
  info: { icono: Info, borde: "border-l-sepia", texto: "text-sepia" },
  ok: { icono: CheckCircle2, borde: "border-l-oliva", texto: "text-oliva" },
  alerta: { icono: AlertTriangle, borde: "border-l-ladrillo", texto: "text-ladrillo" },
} as const;

export function Callout({
  tono = "info",
  titulo,
  texto,
}: {
  tono?: "info" | "ok" | "alerta";
  titulo: string;
  texto?: string;
}) {
  const { icono: Icono, borde, texto: colorTexto } = ESTILOS[tono];
  return (
    <div
      className={`flex items-start gap-3.5 rounded-xl border border-linea border-l-[3px] ${borde} bg-hueso px-5 py-4`}
    >
      <Icono className={`mt-0.5 size-5 shrink-0 ${colorTexto}`} strokeWidth={2.2} />
      <div className="flex flex-col gap-1">
        <p className="font-semibold leading-snug">{titulo}</p>
        {texto && <p className="text-sm leading-relaxed text-sepia">{texto}</p>}
      </div>
    </div>
  );
}
