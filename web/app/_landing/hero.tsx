"use client";

import { motion } from "motion/react";
import { ArrowDown, Play } from "lucide-react";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { useAviso } from "@/components/ui/aviso";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";

// Maqueta abstracta del producto dentro de la tarjeta de "video demo":
// puro div + tokens de la paleta, nada de imágenes.
function MaquetaProducto() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 p-5 md:p-7">
      <div className="flex h-full flex-col gap-3 md:gap-4">
        {/* Barra superior */}
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-hueso/20" />
          <span className="size-2 rounded-full bg-hueso/20" />
          <span className="size-2 rounded-full bg-hueso/20" />
          <span className="ml-3 h-2 w-24 rounded-full bg-hueso/10" />
          <span className="ml-auto h-5 w-16 rounded-full bg-hueso/15" />
        </div>
        {/* Cuerpo: columna de barras + mini grid de tarjetitas */}
        <div className="grid min-h-0 flex-1 grid-cols-3 gap-3">
          <div className="flex flex-col gap-2.5 rounded-xl border border-hueso/10 p-3">
            <span className="h-2 w-3/4 rounded-full bg-hueso/25" />
            <span className="h-2 w-1/2 rounded-full bg-hueso/15" />
            <span className="h-2 w-2/3 rounded-full bg-hueso/15" />
            <span className="h-2 w-1/2 rounded-full bg-hueso/10" />
            <span className="mt-auto h-2 w-1/3 rounded-full bg-hueso/25" />
          </div>
          <div className="col-span-2 grid grid-cols-2 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex flex-col gap-2 rounded-xl border border-hueso/10 bg-hueso/5 p-3"
              >
                <span className="h-2 w-2/3 rounded-full bg-hueso/25" />
                <span className="h-2 w-1/2 rounded-full bg-hueso/10" />
                <span className="mt-auto h-1.5 w-1/3 rounded-full bg-hueso/15" />
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Veladura sutil para dar profundidad */}
      <div className="absolute inset-0 bg-gradient-to-br from-hueso/[0.06] via-transparent to-noche/40" />
    </div>
  );
}

export function Hero() {
  const { avisar, elemento } = useAviso();

  return (
    <section className="flex min-h-svh flex-col pt-36 pb-10 md:pt-44">
      <div className="mx-auto w-full max-w-6xl flex-1 px-6">
        <div className="grid h-full gap-14 md:grid-cols-2 md:gap-0">
          {/* Columna izquierda */}
          <div className="flex flex-col md:pr-12">
            <Reveal desenfoque={false}>
              <Etiqueta punto>PLATAFORMA DE AUTOMATIZACIÓN</Etiqueta>
            </Reveal>

            <h1 className="mt-6 text-5xl leading-[0.95] font-black tracking-tight md:text-7xl">
              <TextoRevelado como="div" texto="Describe tu proceso." />
              <TextoRevelado
                como="div"
                texto="Nosotros lo convertimos en software."
                retraso={0.28}
              />
            </h1>

            <Reveal retraso={0.5}>
              <p className="mt-6 max-w-md text-base leading-relaxed text-sepia md:text-lg">
                Sin programar, sin configurar, sin ver una sola línea de
                código. Lo cuentas una vez y aparece listo en tu portafolio.
              </p>
            </Reveal>

            <Reveal retraso={0.62}>
              <div className="mt-10 flex flex-wrap items-center gap-4">
                <Boton
                  variante="acento"
                  tamano="lg"
                  icono="flecha"
                  href="/nueva"
                  magnetico
                >
                  Crear mi primera automatización
                </Boton>
                <Boton variante="fantasma" tamano="lg" href="/precios">
                  Ver precios
                </Boton>
              </div>
            </Reveal>

            <Reveal retraso={0.85} desenfoque={false} className="mt-auto pt-16">
              <div className="flex items-center gap-3">
                <Etiqueta>DESPLÁZATE PARA VER MÁS</Etiqueta>
                <motion.span
                  aria-hidden
                  className="text-sepia"
                  animate={{ y: [0, 5, 0] }}
                  transition={{
                    duration: 1.8,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                >
                  <ArrowDown className="size-4" strokeWidth={2} />
                </motion.span>
              </div>
            </Reveal>
          </div>

          {/* Columna derecha: tarjeta de video demo */}
          <div className="flex flex-col gap-4 md:border-l md:border-linea md:pl-12">
            <Reveal retraso={0.35}>
              <Etiqueta>VER DEMO — 01:30</Etiqueta>
            </Reveal>
            <Reveal retraso={0.45}>
              <div className="relative aspect-video overflow-hidden rounded-2xl bg-noche">
                <MaquetaProducto />
                <div className="absolute inset-0 flex items-center justify-center">
                  <motion.button
                    type="button"
                    aria-label="Ver el video demo"
                    onClick={() => avisar("El video demo viene pronto")}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: "spring", stiffness: 320, damping: 24 }}
                    className="relative flex size-16 cursor-pointer items-center justify-center rounded-full bg-hueso md:size-20"
                  >
                    <span
                      aria-hidden
                      className="absolute inset-0 animate-ping rounded-full bg-hueso/30 [animation-duration:2.4s]"
                    />
                    <Play
                      className="relative size-6 fill-tinta text-tinta md:size-7"
                      strokeWidth={2}
                    />
                  </motion.button>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
      {elemento}
    </section>
  );
}
