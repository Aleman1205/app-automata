"use client";

import Link from "next/link";
import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { MARCA } from "@/lib/marca";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";

// Pie global: CTA + enlaces + nombre gigante recortado en el borde inferior
// (ref. imagen 2), con parallax sutil al hacer scroll.
export function Pie() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end end"],
  });
  const y = useTransform(scrollYProgress, [0, 1], ["22%", "0%"]);

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
