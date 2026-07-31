"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { reintentarBuild } from "@/lib/automata/lectura";
import { ArrowRight } from "lucide-react";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Estado } from "@/components/ui/estado";
import { PuntosAjustes } from "@/components/ui/puntos-ajustes";
import { Boton } from "@/components/ui/boton";
import { Avatar } from "@/components/ui/avatar";
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
  creadaPor?: string; // nombre de quien la creó
  creadaPorIndice?: number;
  // Lo decide el BACKEND (mismas guardas que app_solicitar_reintento), no la tarjeta: ofrecer un
  // botón que la SD va a rechazar es volver a prometer algo que no pasa.
  reintentable?: boolean;
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
  const [reintentando, setReintentando] = useState(false);
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
            {/* "Reintentar gratis" fue un toast durante mucho tiempo: el cliente creía haber
                relanzado el build y esperaba un correo que nunca llegaba. Ahora POST /reintentar
                existe y rehace el build de verdad sin volver a cobrar — pero SOLO se ofrece si el
                backend dice que esta califica. Cuando no (ya recibió una versión, o se construyó
                antes de que se guardaran spec/ejemplo), se mantiene la salida honesta en vez de un
                botón que va a fallar. */}
            {datos.reintentable ? (
              <Boton
                variante="fantasma"
                tamano="sm"
                icono="reintentar"
                deshabilitado={reintentando}
                onClick={async () => {
                  if (reintentando) return; // doble clic: la SD también deduplica, pero no llegamos
                  setReintentando(true);
                  try {
                    await reintentarBuild(datos.id);
                    alAvisar("Volvimos a construirla. Te avisamos por correo cuando esté lista.");
                    router.refresh();
                  } catch (err) {
                    alAvisar(err instanceof Error ? err.message : "No se pudo reintentar.");
                  } finally {
                    setReintentando(false);
                  }
                }}
              >
                {reintentando ? "Reintentando…" : "Reintentar sin costo"}
              </Boton>
            ) : (
              <Boton variante="fantasma" tamano="sm" icono="reintentar" href="/contacto">
                Escríbenos y la reponemos
              </Boton>
            )}
          </div>
        )}

        {navegable && (
          <div className="mt-auto flex flex-col gap-3 border-t border-linea pt-4">
            {datos.creadaPor && (
              <span className="flex items-center gap-2">
                <Avatar
                  nombre={datos.creadaPor}
                  indice={datos.creadaPorIndice ?? 0}
                  tamano="sm"
                />
                <span className="text-xs text-sepia">
                  Creada por {datos.creadaPor}
                </span>
              </span>
            )}
            <div className="flex items-center justify-between">
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
          </div>
        )}
      </Tarjeta>
    </motion.div>
  );
}
