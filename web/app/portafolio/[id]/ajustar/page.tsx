"use client";

import { use, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Wrench } from "lucide-react";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Boton } from "@/components/ui/boton";
import { useAviso } from "@/components/ui/aviso";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { CheckDibujado } from "@/components/motion/check-dibujado";
import { obtenerAutomatizacion } from "@/lib/datos";
import { Volver } from "../../_componentes/volver";
import { TimelineCambios } from "../../_componentes/timeline-cambios";

const EASING: [number, number, number, number] = [0.22, 1, 0.36, 1];

export default function PaginaAjustar({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const a = obtenerAutomatizacion(id);
  const { avisar, elemento } = useAviso();
  const [texto, setTexto] = useState("");
  const [enviado, setEnviado] = useState(false);

  // ── Guardas: id inexistente o automatización que no admite cambios ────────
  if (!a || a.estado !== "lista") {
    const mensaje = !a
      ? "No encontramos esta automatización. Puede que el enlace esté incompleto."
      : a.estado === "congelada"
        ? "Esta automatización es definitiva: ya no se modifica, pero se sigue ejecutando con normalidad."
        : "Esta automatización aún no está lista para pedir cambios.";
    return (
      <div className="mx-auto max-w-3xl px-6 pb-24 pt-36 md:pb-32 md:pt-44">
        <Reveal className="flex flex-col items-start gap-6">
          <Etiqueta punto>Tu portafolio</Etiqueta>
          <TextoRevelado
            texto="Aquí no hay nada que ajustar."
            como="h1"
            className="text-5xl font-black leading-[0.95] tracking-tight md:text-7xl"
          />
          <p className="max-w-xl leading-relaxed text-sepia">{mensaje}</p>
          <Boton
            variante="oscuro"
            icono="flecha"
            href={a ? `/portafolio/${a.id}` : "/portafolio"}
          >
            {a ? "Volver a la automatización" : "Volver al portafolio"}
          </Boton>
        </Reveal>
      </div>
    );
  }

  const esUltimoAjuste = a.ajustesUsados === 2;

  return (
    <div className="mx-auto max-w-3xl px-6 pb-24 pt-36 md:pb-32 md:pt-44">
      <Reveal desenfoque={false} y={10}>
        <Volver href={`/portafolio/${a.id}`}>Volver</Volver>
      </Reveal>

      <AnimatePresence mode="wait">
        {!enviado ? (
          <motion.div
            key="formulario"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.45, ease: EASING }}
            className="mt-10 flex flex-col gap-10"
          >
            {/* Cabecera */}
            <div className="flex flex-col gap-5">
              <Etiqueta>Ajuste {a.ajustesUsados + 1} de 3</Etiqueta>
              <TextoRevelado
                texto="¿Qué quieres cambiar?"
                como="h1"
                className="text-5xl font-black leading-[0.95] tracking-tight md:text-7xl"
              />
              <p className="max-w-xl leading-relaxed text-sepia">
                {a.nombre} seguirá funcionando igual mientras preparamos la
                nueva versión.
              </p>
            </div>

            {/* Banner de último ajuste */}
            {esUltimoAjuste && (
              <Reveal y={16}>
                <Tarjeta className="border-ladrillo/40 p-5">
                  <div className="flex items-start gap-3">
                    <AlertTriangle
                      className="mt-0.5 size-5 shrink-0 text-ladrillo"
                      strokeWidth={2}
                    />
                    <p className="text-sm leading-relaxed">
                      <span className="font-bold">
                        Este es tu último ajuste.
                      </span>{" "}
                      Después, la automatización queda definitiva. Describe
                      TODOS los cambios que necesites de una vez.
                    </p>
                  </div>
                </Tarjeta>
              </Reveal>
            )}

            {/* Versiones previas */}
            {a.cambios.length > 0 && (
              <Reveal y={16}>
                <TimelineCambios cambios={a.cambios} />
              </Reveal>
            )}

            {/* Qué cambiar */}
            <Reveal y={16} className="flex flex-col gap-4">
              <textarea
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                rows={6}
                placeholder="Ejemplo: además del total por vendedor, quiero ver el promedio por venta…"
                className="w-full resize-none rounded-2xl border border-linea bg-hueso p-5 text-base leading-relaxed text-tinta transition-colors duration-300 placeholder:text-sepia/60 focus:border-tinta focus:outline-none"
              />

              <div className="flex items-start gap-3 rounded-xl border border-linea bg-papel p-5">
                <Wrench
                  className="mt-0.5 size-4 shrink-0 text-sepia"
                  strokeWidth={2}
                />
                <div className="flex flex-col items-start gap-2 text-sm leading-relaxed text-sepia">
                  <p>
                    ¿Algo dejó de funcionar sin que tú cambiaras nada? Eso es
                    una reparación, es gratis y no gasta ajustes.
                  </p>
                  <button
                    type="button"
                    onClick={() => avisar("Recibido — lo revisamos sin costo")}
                    className="font-semibold text-tinta underline-offset-4 transition-colors duration-300 hover:underline"
                  >
                    Reportar una falla
                  </button>
                </div>
              </div>

              <div className="mt-2">
                <Boton
                  variante="acento"
                  icono="check"
                  deshabilitado={!texto.trim()}
                  onClick={() => setEnviado(true)}
                >
                  Enviar el cambio
                </Boton>
              </div>
            </Reveal>
          </motion.div>
        ) : (
          <motion.div
            key="confirmacion"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.45, ease: EASING }}
            className="mt-10 flex flex-col items-center gap-7 py-16 text-center"
          >
            <CheckDibujado />
            <TextoRevelado
              texto="En eso estamos."
              como="h2"
              className="text-4xl font-black tracking-tight md:text-6xl"
            />
            <p className="max-w-md leading-relaxed text-sepia">
              Tu automatización actual sigue funcionando mientras preparamos la
              nueva versión. Te avisamos por correo.
            </p>
            <Boton
              variante="oscuro"
              icono="flecha"
              href={`/portafolio/${a.id}`}
            >
              Volver a la automatización
            </Boton>
          </motion.div>
        )}
      </AnimatePresence>

      {elemento}
    </div>
  );
}
