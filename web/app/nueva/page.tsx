"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ejemplosIdea, rondasEntrevista } from "@/lib/datos";
import { PasoIdea } from "./_componentes/paso-idea";
import { PasoPensando } from "./_componentes/paso-pensando";
import {
  PasoPreguntas,
  type Respuesta,
  type Respuestas,
} from "./_componentes/paso-preguntas";
import { PasoResumen } from "./_componentes/paso-resumen";
import { PasoListo } from "./_componentes/paso-listo";

type Paso = "idea" | "pensando" | "preguntas" | "resumen" | "listo";

// Las dos rondas de la entrevista, aplanadas: 5 preguntas en total.
const preguntas = rondasEntrevista.flat();

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
  const [indice, setIndice] = useState(0);
  const [respuestas, setRespuestas] = useState<Respuestas>({});
  const [archivoSubido, setArchivoSubido] = useState(false);

  // El paso "pensando" dura 1.4 s y avanza solo a las preguntas.
  useEffect(() => {
    if (paso !== "pensando") return;
    const t = setTimeout(() => setPaso("preguntas"), 1400);
    return () => clearTimeout(t);
  }, [paso]);

  const responder = (preguntaId: string, respuesta: Respuesta) => {
    setRespuestas((previas) => ({ ...previas, [preguntaId]: respuesta }));
  };

  const atras = () => {
    if (indice === 0) setPaso("idea");
    else setIndice(indice - 1);
  };

  const continuar = () => {
    if (indice === preguntas.length - 1) setPaso("resumen");
    else setIndice(indice + 1);
  };

  const aprobar = () => {
    const nombre =
      idea.trim() === ejemplosIdea[0]
        ? "Reporte mensual de ventas"
        : idea.trim().slice(0, 46).trimEnd();
    localStorage.setItem("demo_nueva", JSON.stringify({ nombre }));
    setPaso("listo");
  };

  return (
    <section className="mx-auto max-w-3xl px-6 pt-36 pb-24 md:pt-44">
      <AnimatePresence mode="wait">
        {paso === "idea" && (
          <Panel key="idea">
            <PasoIdea
              texto={idea}
              onCambiar={setIdea}
              onContinuar={() => setPaso("pensando")}
            />
          </Panel>
        )}

        {paso === "pensando" && (
          <Panel key="pensando">
            <PasoPensando />
          </Panel>
        )}

        {paso === "preguntas" && (
          <Panel key="preguntas">
            <PasoPreguntas
              preguntas={preguntas}
              indice={indice}
              respuestas={respuestas}
              archivoSubido={archivoSubido}
              onResponder={responder}
              onSubirArchivo={() => setArchivoSubido(true)}
              onAtras={atras}
              onContinuar={continuar}
            />
          </Panel>
        )}

        {paso === "resumen" && (
          <Panel key="resumen">
            <PasoResumen
              onCorregir={() => {
                setIndice(0);
                setPaso("preguntas");
              }}
              onAprobar={aprobar}
            />
          </Panel>
        )}

        {paso === "listo" && (
          <Panel key="listo">
            <PasoListo />
          </Panel>
        )}
      </AnimatePresence>
    </section>
  );
}
