"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { PasoIdea } from "./_componentes/paso-idea";
import { PasoPensando } from "./_componentes/paso-pensando";
import {
  PasoPreguntas,
  type Respuesta,
  type Respuestas,
} from "./_componentes/paso-preguntas";
import { PasoResumen, type DatosResumen } from "./_componentes/paso-resumen";
import { PasoListo } from "./_componentes/paso-listo";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import {
  intakeTurno,
  construirDesdeSpec,
  type EntradaHist,
  type PreguntaIntake,
  type SpecIntake,
  type TurnoIntake,
} from "@/lib/automata/lectura";
import type { PreguntaEntrevista } from "@/lib/datos";

type Paso = "idea" | "pensando" | "preguntas" | "resumen" | "listo" | "rechazado";

// La Pregunta real (core) → la forma que el componente PasoPreguntas ya sabe pintar.
function aPreguntaUI(p: PreguntaIntake): PreguntaEntrevista {
  return {
    id: p.id,
    titulo: p.titulo,
    tipo: p.pide_archivo ? "archivo" : "opciones",
    permiteOtro: p.permite_otro,
    opciones: p.opciones.map((o) => ({ id: o.id, etiqueta: o.etiqueta, detalle: o.detalle, recomendada: o.recomendada })),
    ayuda: p.pide_archivo ? "Sube el archivo que usas en este proceso — con eso entendemos mejor." : undefined,
  };
}

// Panel que entra por la derecha y sale por la izquierda (cambio de paso).
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

export default function NuevaAutomatizacion() {
  const [paso, setPaso] = useState<Paso>("idea");
  const [idea, setIdea] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Conversación con el entrevistador (Sonnet): historial acumulado + turno.
  const [historial, setHistorial] = useState<EntradaHist[]>([]);
  const [turno, setTurno] = useState(1);
  const [preguntas, setPreguntas] = useState<PreguntaEntrevista[]>([]);
  const [indice, setIndice] = useState(0);
  const [respuestas, setRespuestas] = useState<Respuestas>({});
  const [archivo, setArchivo] = useState<File | null>(null);
  const [spec, setSpec] = useState<SpecIntake | null>(null);
  const [construyendo, setConstruyendo] = useState(false);

  const responder = (preguntaId: string, respuesta: Respuesta) => {
    setRespuestas((previas) => ({ ...previas, [preguntaId]: respuesta }));
  };

  // Aterriza el resultado de un turno: siguiente ronda de preguntas, spec, o rechazo.
  const procesar = (res: TurnoIntake) => {
    setError(null);
    if (res.accion === "preguntar") {
      setPreguntas(res.preguntas.map(aPreguntaUI));
      setIndice(0);
      setRespuestas({});
      setArchivo(null);
      setPaso("preguntas");
    } else if (res.accion === "cerrar") {
      setSpec(res.spec);
      setPaso("resumen");
    } else {
      setPaso("rechazado");
    }
  };

  const fallo = (e: unknown) => {
    setError(e instanceof Error ? e.message : "Algo salió mal. Intenta de nuevo.");
    setPaso("idea");
  };

  // Arranca la entrevista con la idea (turno 1).
  const arrancar = async () => {
    if (!idea.trim()) return;
    setError(null);
    setHistorial([]);
    setTurno(1);
    setPaso("pensando");
    try {
      procesar(await intakeTurno(idea, [], 1));
    } catch (e) {
      fallo(e);
    }
  };

  // Respondida la última pregunta de la ronda → arma el historial y pide el siguiente turno.
  const avanzarRonda = async () => {
    const nuevas: EntradaHist[] = preguntas.map((p) => {
      const r = respuestas[p.id];
      if (p.tipo === "archivo") return { pregunta: p.titulo, eleccion: archivo ? "Sí, tengo ese archivo" : "(sin archivo)", libre: false };
      if (r?.opcionId === "otro" && r.otroTexto.trim()) return { pregunta: p.titulo, eleccion: r.otroTexto.trim(), libre: true };
      const op = p.opciones?.find((o) => o.id === r?.opcionId);
      return { pregunta: p.titulo, eleccion: op?.etiqueta ?? "(sin respuesta)", libre: false };
    });
    const hist = [...historial, ...nuevas];
    const t = turno + 1;
    setHistorial(hist);
    setTurno(t);
    setPaso("pensando");
    try {
      procesar(await intakeTurno(idea, hist, t));
    } catch (e) {
      fallo(e);
    }
  };

  const atras = () => {
    if (indice > 0) setIndice(indice - 1);
    else setPaso("idea"); // desde la 1ª pregunta, volver a la idea (reinicia la entrevista)
  };

  const continuar = () => {
    if (indice < preguntas.length - 1) setIndice(indice + 1);
    else void avanzarRonda();
  };

  const datosResumen: DatosResumen | undefined = spec
    ? {
        objetivo: spec.objetivo,
        entradas: spec.entradas.map((e) => e.descripcion),
        salidas: spec.salidas.map((s) => s.descripcion),
        reglas: spec.reglas,
        criterios: spec.criterios_exito.map((c) => c.criterio_cliente),
      }
    : undefined;

  // Aprobar el spec DISPARA el build: sube el archivo de ejemplo → encola la construcción
  // (POST /ejemplo → POST /construir). El drainer (cron) corre el planner + CMA fuera del request.
  const aprobar = async () => {
    if (!spec || construyendo) return;
    if (!archivo) {
      setError("Nos falta el archivo de ejemplo para construirla — súbelo aquí abajo.");
      return;
    }
    setError(null);
    setConstruyendo(true);
    try {
      await construirDesdeSpec(spec, archivo);
      setPaso("listo");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo iniciar la construcción. Intenta de nuevo.");
    } finally {
      setConstruyendo(false);
    }
  };

  return (
    <section className="mx-auto max-w-3xl px-6 pt-36 pb-24 md:pt-44">
      <AnimatePresence mode="wait">
        {paso === "idea" && (
          <Panel key="idea">
            {error && (
              <div className="mb-6 rounded-xl border border-linea bg-papel px-4 py-3 text-sm text-ladrillo">
                {error}
              </div>
            )}
            <PasoIdea texto={idea} onCambiar={setIdea} onContinuar={arrancar} />
          </Panel>
        )}

        {paso === "pensando" && (
          <Panel key="pensando">
            <PasoPensando />
          </Panel>
        )}

        {paso === "preguntas" && preguntas.length > 0 && (
          <Panel key="preguntas">
            <PasoPreguntas
              preguntas={preguntas}
              indice={indice}
              respuestas={respuestas}
              archivo={archivo}
              onResponder={responder}
              onArchivo={setArchivo}
              onAtras={atras}
              onContinuar={continuar}
            />
          </Panel>
        )}

        {paso === "resumen" && (
          <Panel key="resumen">
            <PasoResumen
              datos={datosResumen}
              archivo={archivo}
              onArchivo={setArchivo}
              cargando={construyendo}
              error={error}
              onCorregir={() => setPaso("idea")}
              onAprobar={aprobar}
            />
          </Panel>
        )}

        {paso === "listo" && (
          <Panel key="listo">
            <PasoListo />
          </Panel>
        )}

        {paso === "rechazado" && (
          <Panel key="rechazado">
            <div className="flex flex-col items-start gap-6">
              <Etiqueta punto>No es para nosotros</Etiqueta>
              <h2 className="text-3xl font-black tracking-tight md:text-5xl">
                Esto no lo podemos construir.
              </h2>
              <p className="max-w-xl leading-relaxed text-sepia">
                Automata convierte procesos de tipo &ldquo;archivo → resultado&rdquo;. Lo que
                describiste queda fuera de eso (o necesita algo que hoy no hacemos). Prueba
                describiendo un proceso donde subes un archivo y quieres un reporte de vuelta.
              </p>
              <div className="flex flex-wrap gap-4">
                <Boton variante="oscuro" icono="flecha" onClick={() => { setError(null); setPaso("idea"); }}>
                  Describir otro proceso
                </Boton>
                <Link href="/portafolio" className="self-center text-sm text-sepia underline-offset-4 hover:underline">
                  Volver al portafolio
                </Link>
              </div>
            </div>
          </Panel>
        )}
      </AnimatePresence>
    </section>
  );
}
