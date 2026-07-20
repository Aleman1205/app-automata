"use client";

import { createElement, Fragment, useRef } from "react";
import { motion, useInView } from "motion/react";

// Título que se revela palabra por palabra desde una máscara
// (animshelf: Split Text + Slide Mask).
//
// OJO: el observer va sobre el TÍTULO, no sobre cada palabra. Las palabras
// arrancan desplazadas 115% dentro de una máscara overflow-hidden, y para
// IntersectionObserver un elemento totalmente recortado por su ancestro tiene
// intersección cero — whileInView por palabra jamás dispararía (deadlock).
export function TextoRevelado({
  texto,
  como = "h2",
  className = "",
  retraso = 0,
}: {
  texto: string;
  como?: "h1" | "h2" | "h3" | "p" | "div";
  className?: string;
  retraso?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const enVista = useInView(ref, { once: true, margin: "-60px" });
  const palabras = texto.split(" ");

  return createElement(
    como,
    { className, ref },
    palabras.map((palabra, i) => (
      // El espacio va FUERA de la máscara: dentro de un inline-block, un
      // espacio final se recorta y las palabras quedarían pegadas.
      <Fragment key={i}>
        <span className="-mb-[0.12em] inline-block overflow-hidden pb-[0.12em] align-bottom">
          <motion.span
            className="inline-block will-change-transform"
            initial={{ y: "115%" }}
            animate={enVista ? { y: "0%" } : { y: "115%" }}
            transition={{
              duration: 0.65,
              delay: retraso + i * 0.045,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            {palabra}
          </motion.span>
        </span>
        {i < palabras.length - 1 ? " " : null}
      </Fragment>
    )),
  );
}
