"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { motion } from "motion/react";
import { MARCA } from "@/lib/marca";
import { Boton } from "@/components/ui/boton";

// Topbar de píldora (ref. imagen 3): la píldora clara SE DESLIZA entre
// opciones al pasar el mouse — sin hacer clic. Al salir, vuelve a la ruta
// activa. El clic sí navega.
const enlaces = [
  { href: "/", etiqueta: "Inicio" },
  { href: "/portafolio", etiqueta: "Portafolio" },
  { href: "/precios", etiqueta: "Precios" },
];

export function Topbar() {
  const ruta = usePathname();
  // Sin fallback: en rutas fuera del menú (p. ej. /nueva) no se resalta nada.
  const activo =
    enlaces.find((e) =>
      e.href === "/" ? ruta === "/" : ruta.startsWith(e.href),
    )?.href ?? null;
  const [flotante, setFlotante] = useState<string | null>(null);
  const resaltado = flotante ?? activo;

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50">
      <div className="relative flex items-center justify-between px-6 py-4">
        <Link
          href="/"
          className="pointer-events-auto text-lg font-black tracking-tight"
        >
          {MARCA}
          <span className="text-acento">.</span>
        </Link>

        <nav
          onMouseLeave={() => setFlotante(null)}
          className="pointer-events-auto absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 rounded-full bg-noche p-1.5 shadow-lg shadow-noche/25 md:flex"
        >
          {enlaces.map((e) => (
            <Link
              key={e.href}
              href={e.href}
              onMouseEnter={() => setFlotante(e.href)}
              className="relative rounded-full px-5 py-2 text-sm font-medium"
            >
              {resaltado === e.href && (
                <motion.span
                  layoutId="pildora-nav"
                  className="absolute inset-0 rounded-full bg-hueso"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              <span
                className={`relative z-10 transition-colors duration-200 ${
                  resaltado === e.href ? "text-noche" : "text-crema/70"
                }`}
              >
                {e.etiqueta}
              </span>
            </Link>
          ))}
        </nav>

        <div className="pointer-events-auto">
          <Boton href="/nueva" variante="acento" tamano="sm" icono="flecha">
            Nueva automatización
          </Boton>
        </div>
      </div>
    </header>
  );
}
