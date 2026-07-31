"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Menu, X } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { MARCA } from "@/lib/marca";
import { Boton } from "@/components/ui/boton";
import { Avatar } from "@/components/ui/avatar";
import { usuarioActual } from "@/lib/datos";
import { CLERK_ACTIVO } from "@/lib/automata/dev";

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
  { href: "/portafolio", etiqueta: "Portafolio" },
  { href: "/equipo", etiqueta: "Equipo" },
];

// /panel se BORRÓ (no solo se quitó del nav): era 100% demo —pintaba los datos del hotel de
// ejemplo aunque hubiera backend real, a diferencia del resto que cae a los falsos solo si NO hay
// backend— y a un cliente real le habría mostrado el negocio de otro. Lo que enseñaba ya vive
// cableado en /portafolio, /cuenta y /equipo. Está en el historial de git si se quiere revivir.
const RUTAS_APP = ["/portafolio", "/equipo", "/cuenta", "/nueva"];
const RUTAS_LIMPIAS = ["/entrar"]; // sin topbar (login)

export function Topbar() {
  const ruta = usePathname();
  const [flotante, setFlotante] = useState<string | null>(null);
  const [menuMovil, setMenuMovil] = useState(false);

  if (RUTAS_LIMPIAS.includes(ruta)) return null;

  const esApp = RUTAS_APP.some((r) => ruta === r || ruta.startsWith(r + "/"));
  const enlaces = esApp ? enlacesApp : enlacesVenta;

  const activo =
    enlaces.find((e) =>
      e.href === "/" ? ruta === "/" : ruta.startsWith(e.href),
    )?.href ?? null;
  const resaltado = flotante ?? activo;

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50">
      <div className="relative flex items-center justify-between px-6 py-4">
        <Link
          href={esApp ? "/portafolio" : "/"}
          className="pointer-events-auto text-lg font-black tracking-tight"
        >
          {MARCA}
          <span className="text-acento">.</span>
        </Link>

        {/* Nav central — solo escritorio */}
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

        {/* Acciones — solo escritorio */}
        <div className="pointer-events-auto hidden items-center gap-3 md:flex">
          {esApp ? (
            <>
              <Boton href="/nueva" variante="acento" tamano="sm" icono="flecha">
                Nueva automatización
              </Boton>
              {CLERK_ACTIVO ? (
                // Menú de usuario REAL (cerrar sesión, cuenta) de Clerk.
                <UserButton afterSignOutUrl="/" />
              ) : (
                <Link
                  href="/cuenta"
                  aria-label="Tu cuenta"
                  className="transition-transform duration-200 hover:scale-105"
                >
                  <Avatar nombre={usuarioActual().nombre} anillo />
                </Link>
              )}
            </>
          ) : (
            <>
              <Boton href="/entrar" variante="fantasma" tamano="sm">
                Entrar
              </Boton>
              <Boton href="/nueva" variante="acento" tamano="sm" icono="flecha">
                Empezar
              </Boton>
            </>
          )}
        </div>

        {/* Botón hamburguesa — solo móvil */}
        <button
          onClick={() => setMenuMovil((v) => !v)}
          aria-label={menuMovil ? "Cerrar menú" : "Abrir menú"}
          className="pointer-events-auto flex size-10 items-center justify-center rounded-full bg-noche text-crema md:hidden"
        >
          {menuMovil ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {/* Panel del menú móvil */}
      <AnimatePresence>
        {menuMovil && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto mx-4 overflow-hidden rounded-2xl bg-noche p-4 shadow-xl shadow-noche/30 md:hidden"
          >
            <nav className="flex flex-col">
              {enlaces.map((e) => (
                <Link
                  key={e.href}
                  href={e.href}
                  onClick={() => setMenuMovil(false)}
                  className={`rounded-xl px-4 py-3 text-base font-medium transition-colors ${
                    activo === e.href
                      ? "bg-hueso text-noche"
                      : "text-crema/80 hover:text-crema"
                  }`}
                >
                  {e.etiqueta}
                </Link>
              ))}
            </nav>

            <div className="mt-4 flex flex-col gap-2.5 border-t border-crema/15 pt-4">
              {esApp ? (
                <>
                  <Boton
                    href="/nueva"
                    variante="acento"
                    icono="flecha"
                    onClick={() => setMenuMovil(false)}
                    className="w-full"
                  >
                    Nueva automatización
                  </Boton>
                  <Link
                    href="/cuenta"
                    onClick={() => setMenuMovil(false)}
                    className="flex items-center gap-3 rounded-xl px-2 py-2 text-crema/80 transition-colors hover:text-crema"
                  >
                    <Avatar nombre={usuarioActual().nombre} tamano="sm" />
                    <span className="text-sm font-medium">Tu cuenta</span>
                  </Link>
                </>
              ) : (
                <>
                  <Boton
                    href="/entrar"
                    variante="fantasma"
                    onClick={() => setMenuMovil(false)}
                    className="w-full !border-crema/25 !text-crema"
                  >
                    Entrar
                  </Boton>
                  <Boton
                    href="/nueva"
                    variante="acento"
                    icono="flecha"
                    onClick={() => setMenuMovil(false)}
                    className="w-full"
                  >
                    Empezar
                  </Boton>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
