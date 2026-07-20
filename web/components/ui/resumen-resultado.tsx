import { Etiqueta } from "@/components/ui/etiqueta";

// Bloque narrativo: el hallazgo en lenguaje llano, arriba del resultado. Le da
// contexto humano a las cifras antes de que el usuario lea tablas y gráficas.
export function ResumenResultado({ texto }: { texto: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Etiqueta punto>En resumen</Etiqueta>
      <p className="max-w-2xl text-lg leading-relaxed text-tinta md:text-xl">
        {texto}
      </p>
    </div>
  );
}
