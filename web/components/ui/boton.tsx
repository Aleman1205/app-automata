"use client";

import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Download,
  Play,
  Plus,
  RotateCcw,
} from "lucide-react";
import { Magnetico } from "@/components/motion/magnetico";

const iconos = {
  flecha: ArrowRight,
  diagonal: ArrowUpRight,
  descarga: Download,
  mas: Plus,
  play: Play,
  reintentar: RotateCcw,
  check: Check,
};

// Botón del sistema. El texto hace "slide-swap" al pasar el mouse y la
// variante acento lleva un destello que la cruza (animshelf: Shine Sweep).
// REGLA: la variante "acento" es SOLO para la acción principal de la pantalla.
export function Boton({
  children,
  variante = "oscuro",
  tamano = "md",
  href,
  onClick,
  icono,
  type = "button",
  deshabilitado = false,
  magnetico = false,
  className = "",
}: {
  children: string;
  variante?: "acento" | "oscuro" | "fantasma";
  tamano?: "sm" | "md" | "lg";
  href?: string;
  onClick?: () => void;
  icono?: keyof typeof iconos;
  type?: "button" | "submit";
  deshabilitado?: boolean;
  magnetico?: boolean;
  className?: string;
}) {
  const base =
    "group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full font-semibold transition-[background-color,border-color,box-shadow,opacity] duration-300 select-none active:scale-[0.97]";
  const variantes = {
    acento:
      "bg-acento text-hueso hover:bg-[#e64500] shadow-[0_10px_30px_-10px_rgba(255,77,0,0.55)]",
    oscuro: "bg-noche text-crema hover:bg-tinta",
    fantasma: "border border-linea bg-transparent text-tinta hover:border-tinta",
  };
  const tamanos = {
    sm: "px-4 py-2 text-sm",
    md: "px-6 py-3 text-sm",
    lg: "px-8 py-4 text-base",
  };
  const Icono = icono ? iconos[icono] : null;

  const contenido = (
    <>
      {variante === "acento" && (
        <span
          aria-hidden
          className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full"
        />
      )}
      <span className="relative block overflow-hidden">
        <span className="block transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-[110%]">
          {children}
        </span>
        <span
          aria-hidden
          className="absolute inset-0 block translate-y-[110%] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-y-0"
        >
          {children}
        </span>
      </span>
      {Icono && (
        <Icono
          className="size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-0.5"
          strokeWidth={2.5}
        />
      )}
    </>
  );

  const clases = `${base} ${variantes[variante]} ${tamanos[tamano]} ${
    deshabilitado ? "pointer-events-none opacity-40" : ""
  } ${className}`;

  const nucleo = href ? (
    <Link href={href} className={clases} onClick={onClick}>
      {contenido}
    </Link>
  ) : (
    <button
      type={type}
      className={clases}
      onClick={onClick}
      disabled={deshabilitado}
    >
      {contenido}
    </button>
  );

  return magnetico ? <Magnetico>{nucleo}</Magnetico> : nucleo;
}
