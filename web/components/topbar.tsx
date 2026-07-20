"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { motion } from "motion/react";
import { MARCA } from "@/lib/marca";
import { Boton } from "@/components/ui/boton";
import { Avatar } from "@/components/ui/avatar";
import { usuarioActual } from "@/lib/datos";

// El sitio tiene DOS mundos:
//  · venta (público): landing, precios, sobre, contacto, legal
//  · app (cliente activo): panel, portafolio, equipo, cuenta, nueva
// El topbar detecta en cuál está y muestra el menú correspondiente.

const enlacesVenta = [
  { href: "/", etiqueta: "Inicio" },
  { href: "/precios", etiqueta: "Precios" },
  { href: "/sobre", etiqueta: "Nosotros" },
];

const enlacesApp = [
  { href: "/panel", etiqueta: "Panel" },
  { href: "/portafolio", etiqueta: "Portafolio" },
  { href: "/equipo", etiqueta: "Equipo" },
];

const RUTAS_APP = ["/panel", "/portafolio", "/equipo", "/cuenta", "/nueva"];

export function Topbar() {
  const ruta = usePathname();
  const esApp = RUTAS_APP.some((r) => ruta === r || ruta.startsWith(r + "/"));
  const enlaces = esApp ? enlacesApp : enlacesVenta;

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
          href={esApp ? "/panel" : "/"}
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

        <div className="pointer-events-auto flex items-center gap-3">
          {esApp ? (
            <>
              <Boton href="/nueva" variante="acento" tamano="sm" icono="flecha">
                Nueva automatización
              </Boton>
              <Link
                href="/cuenta"
                aria-label="Tu cuenta"
                className="transition-transform duration-200 hover:scale-105"
              >
                <Avatar nombre={usuarioActual().nombre} anillo />
              </Link>
            </>
          ) : (
            <>
              <Boton href="/panel" variante="fantasma" tamano="sm">
                Entrar
              </Boton>
              <Boton href="/nueva" variante="acento" tamano="sm" icono="flecha">
                Empezar
              </Boton>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
