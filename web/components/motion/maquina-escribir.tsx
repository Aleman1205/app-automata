"use client";

import { useEffect, useState } from "react";

// Texto que se escribe y borra solo, en bucle (animshelf: Typewriter).
// Úsalo como placeholder animado sobre un textarea vacío.
export function MaquinaEscribir({
  frases,
  velocidad = 32,
  pausa = 2000,
}: {
  frases: string[];
  velocidad?: number;
  pausa?: number;
}) {
  const [indice, setIndice] = useState(0);
  const [largo, setLargo] = useState(0);
  const [borrando, setBorrando] = useState(false);

  useEffect(() => {
    const frase = frases[indice % frases.length];
    let t: ReturnType<typeof setTimeout>;
    if (!borrando && largo < frase.length) {
      t = setTimeout(() => setLargo(largo + 1), velocidad);
    } else if (!borrando && largo === frase.length) {
      t = setTimeout(() => setBorrando(true), pausa);
    } else if (borrando && largo > 0) {
      t = setTimeout(() => setLargo(largo - 1), velocidad / 2);
    } else {
      t = setTimeout(() => {
        setBorrando(false);
        setIndice(indice + 1);
      }, 350);
    }
    return () => clearTimeout(t);
  }, [largo, borrando, indice, frases, velocidad, pausa]);

  return (
    <span>
      {frases[indice % frases.length].slice(0, largo)}
      <span className="animate-pulse">|</span>
    </span>
  );
}
