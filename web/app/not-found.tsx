import Link from "next/link";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";

export default function NoEncontrado() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <Etiqueta punto>Error 404</Etiqueta>
      <h1 className="mt-5 text-6xl font-black tracking-tight md:text-8xl">
        Aquí no hay nada.
      </h1>
      <p className="mt-5 max-w-md text-lg leading-relaxed text-sepia">
        La página que buscas no existe, o el enlace cambió de lugar. Pasa, no
        fue tu culpa.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <Boton href="/" variante="acento" icono="flecha">
          Volver al inicio
        </Boton>
        <Boton href="/portafolio" variante="fantasma">
          Ir a mi portafolio
        </Boton>
      </div>
    </div>
  );
}
