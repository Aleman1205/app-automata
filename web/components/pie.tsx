"use client";

import Link from "next/link";
import { useRef } from "react";
import { usePathname } from "next/navigation";
import { motion, useScroll, useTransform } from "motion/react";
import { MARCA } from "@/lib/marca";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";

const RUTAS_APP = ["/panel", "/portafolio", "/equipo", "/cuenta", "/nueva"];

// Pie global. En el sitio de venta: CTA grande + enlaces + nombre gigante con
// parallax. En la app (cliente activo): una barra compacta, sin CTA de venta.
export function Pie() {
  const ruta = usePathname();
  const esApp = RUTAS_APP.some((r) => ruta === r || ruta.startsWith(r + "/"));

  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end end"],
  });
  const y = useTransform(scrollYProgress, [0, 1], ["22%", "0%"]);

  if (esApp) {
    return (
      <footer className="border-t border-linea bg-papel">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-6 text-center sm:flex-row sm:text-left">
          <Etiqueta>© 2026 {MARCA}</Etiqueta>
          <nav className="flex items-center gap-5 text-sm text-sepia">
            <Link href="/cuenta" className="transition-colors hover:text-tinta">
              Cuenta
            </Link>
            <Link href="/privacidad" className="transition-colors hover:text-tinta">
              Privacidad
            </Link>
            <Link href="/terminos" className="transition-colors hover:text-tinta">
              Términos
            </Link>
            <Link href="/contacto" className="transition-colors hover:text-tinta">
              Soporte
            </Link>
          </nav>
        </div>
      </footer>
    );
  }

  return (
    <footer
      ref={ref}
      className="relative overflow-hidden border-t border-linea bg-papel"
    >
      <div className="mx-auto max-w-6xl px-6 pt-20 pb-10">
        <div className="flex flex-col justify-between gap-12 md:flex-row md:items-end">
          <div className="max-w-md">
            <Etiqueta punto>¿Listo?</Etiqueta>
            <h3 className="mt-3 text-3xl font-black tracking-tight">
              Deja de hacerlo a mano.
            </h3>
            <div className="mt-6">
              <Boton href="/nueva" variante="acento" icono="flecha" magnetico>
                Crear mi automatización
              </Boton>
            </div>
          </div>

          <nav className="grid grid-cols-2 gap-x-16 gap-y-2.5 text-sm md:grid-cols-3">
            <div className="flex flex-col gap-2.5">
              <Etiqueta className="mb-1">Producto</Etiqueta>
              <Link href="/portafolio" className="text-sepia transition-colors hover:text-tinta">
                Portafolio
              </Link>
              <Link href="/precios" className="text-sepia transition-colors hover:text-tinta">
                Precios
              </Link>
              <Link href="/nueva" className="text-sepia transition-colors hover:text-tinta">
                Nueva automatización
              </Link>
            </div>
            <div className="flex flex-col gap-2.5">
              <Etiqueta className="mb-1">Compañía</Etiqueta>
              <Link href="/sobre" className="text-sepia transition-colors hover:text-tinta">
                Sobre nosotros
              </Link>
              <Link href="/contacto" className="text-sepia transition-colors hover:text-tinta">
                Contacto
              </Link>
            </div>
            <div className="flex flex-col gap-2.5">
              <Etiqueta className="mb-1">Legal</Etiqueta>
              <Link href="/privacidad" className="text-sepia transition-colors hover:text-tinta">
                Privacidad
              </Link>
              <Link href="/terminos" className="text-sepia transition-colors hover:text-tinta">
                Términos
              </Link>
            </div>
          </nav>
        </div>

        <div className="mt-16 flex items-center justify-between border-t border-linea pt-6">
          <Etiqueta>© 2026 {MARCA}</Etiqueta>
          <Etiqueta>Hecho para automatizar</Etiqueta>
        </div>
      </div>

      <div className="pointer-events-none select-none">
        <motion.div
          style={{ y }}
          className="-mb-[0.16em] text-center text-[19vw] leading-[0.78] font-black tracking-[-0.04em] text-tinta uppercase"
        >
          {MARCA}
        </motion.div>
      </div>
    </footer>
  );
}
