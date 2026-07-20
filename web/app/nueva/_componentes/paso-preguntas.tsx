"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, FileSpreadsheet, Upload } from "lucide-react";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import type { OpcionEntrevista, PreguntaEntrevista } from "@/lib/datos";

export interface Respuesta {
  opcionId: string;
  otroTexto: string;
}

export type Respuestas = Record<string, Respuesta>;

// Círculo de selección: aparece con un pequeño spring al elegir la tarjeta.
function CirculoSeleccion({ activa }: { activa: boolean }) {
  return (
    <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-linea">
      <AnimatePresence>
        {activa && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 24 }}
            className="absolute -inset-0.5 flex items-center justify-center rounded-full bg-tinta"
          >
            <Check className="size-3.5 text-hueso" strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function TarjetaOpcion({
  opcion,
  seleccionada,
  onSeleccionar,
}: {
  opcion: OpcionEntrevista;
  seleccionada: boolean;
  onSeleccionar: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSeleccionar}
      className={`w-full rounded-2xl border-2 bg-hueso p-5 text-left transition ${
        seleccionada ? "border-tinta" : "border-linea hover:border-sepia"
      }`}
    >
      <span className="flex items-center justify-between gap-4">
        <span>
          <span className="flex flex-wrap items-center gap-2 font-bold text-tinta">
            {opcion.etiqueta}
            {opcion.recomendada && (
              <span className="rounded-full border border-linea px-2 py-0.5 font-mono text-[10px] tracking-[0.14em] text-sepia uppercase">
                Recomendada
              </span>
            )}
          </span>
          <span className="mt-1 block text-sm text-sepia">{opcion.detalle}</span>
        </span>
        <CirculoSeleccion activa={seleccionada} />
      </span>
    </button>
  );
}

// "Otra cosa…": al seleccionarse expande un campo de texto libre.
function TarjetaOtra({
  seleccionada,
  texto,
  onSeleccionar,
  onEscribir,
}: {
  seleccionada: boolean;
  texto: string;
  onSeleccionar: () => void;
  onEscribir: (valor: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSeleccionar}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSeleccionar();
      }}
      className={`w-full cursor-pointer rounded-2xl border-2 bg-hueso p-5 text-left transition ${
        seleccionada ? "border-tinta" : "border-linea hover:border-sepia"
      }`}
    >
      <span className="flex items-center justify-between gap-4">
        <span>
          <span className="block font-bold text-tinta">Otra cosa…</span>
          <span className="mt-1 block text-sm text-sepia">
            Ninguna de estas opciones describe mi caso
          </span>
        </span>
        <CirculoSeleccion activa={seleccionada} />
      </span>
      <AnimatePresence initial={false}>
        {seleccionada && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <input
              type="text"
              value={texto}
              onChange={(e) => onEscribir(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Cuéntanos con tus palabras — si sientes que vamos por otro lado, aquí nos corriges"
              className="mt-4 w-full rounded-full border border-linea bg-crema px-5 py-3 text-sm text-tinta transition placeholder:text-sepia focus:border-tinta focus:outline-none"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Pregunta tipo "archivo": dropzone que simula la subida al hacer clic.
function ZonaArchivo({
  ayuda,
  subido,
  onSubir,
  onSaltar,
}: {
  ayuda?: string;
  subido: boolean;
  onSubir: () => void;
  onSaltar: () => void;
}) {
  if (subido) {
    return (
      <motion.div
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 24 }}
        className="flex items-center gap-4 rounded-2xl border border-linea bg-hueso p-5"
      >
        <FileSpreadsheet className="size-6 shrink-0 text-sepia" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className="font-bold text-tinta">ventas-marzo.xlsx</p>
          <p className="text-sm text-sepia">
            Recibido — con esto entendemos tu proceso a la primera
          </p>
        </div>
        <Check className="size-5 shrink-0 text-oliva" strokeWidth={3} />
      </motion.div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onSubir}
        className="w-full rounded-2xl border-2 border-dashed border-linea p-12 text-center transition hover:border-sepia"
      >
        <Upload className="mx-auto size-8 text-sepia" strokeWidth={1.75} />
        {ayuda && (
          <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-sepia">
            {ayuda}
          </p>
        )}
        <span className="mt-4 inline-block font-mono text-[11px] tracking-[0.18em] text-sepia uppercase">
          Haz clic para elegir tu archivo
        </span>
      </button>
      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={onSaltar}
          className="text-sm text-sepia underline decoration-linea underline-offset-4 transition hover:text-tinta"
        >
          Prefiero saltar este paso
        </button>
      </div>
    </div>
  );
}

// Paso "preguntas": recorre una por una las preguntas de la entrevista,
// con barra de progreso persistente y cambio animado entre preguntas.
export function PasoPreguntas({
  preguntas,
  indice,
  respuestas,
  archivoSubido,
  onResponder,
  onSubirArchivo,
  onAtras,
  onContinuar,
}: {
  preguntas: PreguntaEntrevista[];
  indice: number;
  respuestas: Respuestas;
  archivoSubido: boolean;
  onResponder: (preguntaId: string, respuesta: Respuesta) => void;
  onSubirArchivo: () => void;
  onAtras: () => void;
  onContinuar: () => void;
}) {
  const pregunta = preguntas[indice];
  const total = preguntas.length;
  const ultima = indice === total - 1;
  const respuesta = respuestas[pregunta.id];
  const puedeContinuar = pregunta.tipo === "archivo" || Boolean(respuesta);

  const seleccionar = (opcionId: string) => {
    onResponder(pregunta.id, {
      opcionId,
      otroTexto: respuesta?.otroTexto ?? "",
    });
  };

  return (
    <div>
      <Etiqueta>
        PREGUNTA {indice + 1} DE {total}
      </Etiqueta>
      <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-linea">
        <motion.div
          className="h-full rounded-full bg-tinta"
          initial={{ width: "0%" }}
          animate={{ width: `${((indice + 1) / total) * 100}%` }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={pregunta.id}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="mt-10"
        >
          <TextoRevelado
            como="h2"
            texto={pregunta.titulo}
            className="text-3xl font-black tracking-tight md:text-5xl"
          />

          {pregunta.tipo === "opciones" ? (
            <div className="mt-8 flex flex-col gap-3">
              {pregunta.opciones?.map((opcion, i) => (
                <Reveal key={opcion.id} retraso={0.1 + i * 0.08} y={18}>
                  <TarjetaOpcion
                    opcion={opcion}
                    seleccionada={respuesta?.opcionId === opcion.id}
                    onSeleccionar={() => seleccionar(opcion.id)}
                  />
                </Reveal>
              ))}
              {pregunta.permiteOtro && (
                <Reveal
                  retraso={0.1 + (pregunta.opciones?.length ?? 0) * 0.08}
                  y={18}
                >
                  <TarjetaOtra
                    seleccionada={respuesta?.opcionId === "otro"}
                    texto={respuesta?.otroTexto ?? ""}
                    onSeleccionar={() => seleccionar("otro")}
                    onEscribir={(valor) =>
                      onResponder(pregunta.id, {
                        opcionId: "otro",
                        otroTexto: valor,
                      })
                    }
                  />
                </Reveal>
              )}
            </div>
          ) : (
            <Reveal retraso={0.1} y={18} className="mt-8">
              <ZonaArchivo
                ayuda={pregunta.ayuda}
                subido={archivoSubido}
                onSubir={onSubirArchivo}
                onSaltar={onContinuar}
              />
            </Reveal>
          )}

          <div className="mt-12 flex flex-wrap items-center justify-between gap-4">
            <Boton variante="fantasma" onClick={onAtras}>
              Atrás
            </Boton>
            {ultima ? (
              <Boton
                variante="acento"
                icono="flecha"
                deshabilitado={!puedeContinuar}
                onClick={onContinuar}
              >
                Ver el resumen
              </Boton>
            ) : (
              <Boton
                variante="oscuro"
                icono="flecha"
                deshabilitado={!puedeContinuar}
                onClick={onContinuar}
              >
                Continuar
              </Boton>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
