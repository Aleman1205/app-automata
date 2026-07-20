"use client";

import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Estado } from "@/components/ui/estado";
import { PuntosAjustes } from "@/components/ui/puntos-ajustes";
import { Boton } from "@/components/ui/boton";
import type { EstadoAuto } from "@/lib/datos";

// Datos mínimos que necesita la tarjeta — así también sirve para la
// automatización "demo viva" que no existe en lib/datos.
export interface DatosTarjeta {
  id: string;
  nombre: string;
  descripcion: string;
  estado: EstadoAuto;
  creada: string;
  ejecuciones: number;
  ajustesUsados: number;
  motivoFallo?: string;
}

export function TarjetaAutomatizacion({
  datos,
  recienCreada = false,
  celebrar = false,
  alAvisar,
}: {
  datos: DatosTarjeta;
  recienCreada?: boolean;
  celebrar?: boolean;
  alAvisar: (texto: string) => void;
}) {
  const router = useRouter();
  const navegable = datos.estado === "lista" || datos.estado === "congelada";

  return (
    <motion.div
      className="h-full"
      animate={celebrar ? { scale: [1, 1.04, 1] } : { scale: 1 }}
      transition={{ duration: 0.7, times: [0, 0.4, 1], ease: [0.22, 1, 0.36, 1] }}
    >
      <Tarjeta
        interactiva={navegable}
        tilt={navegable}
        className={`flex h-full flex-col gap-4 p-6 ${navegable ? "group" : ""}`}
        onClick={
          navegable ? () => router.push(`/portafolio/${datos.id}`) : undefined
        }
      >
        {/* Fila superior: estado + fecha */}
        <div className="flex items-center justify-between gap-3">
          <Estado estado={datos.estado} />
          <Etiqueta>{datos.creada}</Etiqueta>
        </div>

        {/* Nombre y descripción */}
        <div className="flex flex-col gap-2">
          <h3 className="text-xl font-bold leading-snug tracking-tight">
            {datos.nombre}
            {recienCreada && (
              <span className="ml-2 inline-block translate-y-[-2px] rounded-full border border-linea bg-papel px-2.5 py-1 align-middle font-mono text-[10px] uppercase tracking-[0.14em] text-sepia">
                Recién creada
              </span>
            )}
          </h3>
          <p className="line-clamp-2 text-sm leading-relaxed text-sepia">
            {datos.descripcion}
          </p>
        </div>

        {/* Zona inferior según estado */}
        {datos.estado === "generando" && (
          <div className="mt-auto flex flex-col gap-3 pt-2">
            <div className="esqueleto h-14 rounded-xl" />
            <div className="barra-indeterminada h-1" />
            <p className="text-sm text-sepia">
              Te avisaremos por correo cuando esté lista.
            </p>
          </div>
        )}

        {datos.estado === "fallo" && (
          <div className="mt-auto flex flex-col items-start gap-3 border-t border-linea pt-4">
            {datos.motivoFallo && (
              <p className="line-clamp-2 text-sm leading-relaxed text-sepia">
                {datos.motivoFallo}
              </p>
            )}
            <Boton
              variante="fantasma"
              tamano="sm"
              icono="reintentar"
              onClick={() =>
                alAvisar("Reintento lanzado — te avisamos por correo")
              }
            >
              Reintentar gratis
            </Boton>
          </div>
        )}

        {navegable && (
          <div className="mt-auto flex items-center justify-between border-t border-linea pt-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-sepia">
              {datos.ejecuciones} ejecuciones
            </span>
            <span className="flex items-center gap-3">
              <PuntosAjustes usados={datos.ajustesUsados} conTexto={false} />
              <ArrowRight
                className="size-4 text-sepia transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1 group-hover:text-tinta"
                strokeWidth={2.5}
              />
            </span>
          </div>
        )}
      </Tarjeta>
    </motion.div>
  );
}
