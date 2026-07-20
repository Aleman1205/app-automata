import { Etiqueta } from "@/components/ui/etiqueta";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";

export interface SeccionTexto {
  titulo: string;
  parrafos: string[];
}

// Plantilla para páginas informativas y legales: cabecera + secciones con
// Reveal escalonado. Mantiene el ritmo y la tipografía del sistema.
export function PaginaTexto({
  etiqueta,
  titulo,
  entrada,
  secciones,
  pie,
}: {
  etiqueta: string;
  titulo: string;
  entrada?: string;
  secciones: SeccionTexto[];
  pie?: string;
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 pt-36 pb-24 md:pt-44">
      <Reveal>
        <Etiqueta punto>{etiqueta}</Etiqueta>
      </Reveal>
      <TextoRevelado
        como="h1"
        texto={titulo}
        className="mt-4 text-5xl font-black tracking-tight md:text-6xl"
        retraso={0.1}
      />
      {entrada && (
        <Reveal retraso={0.3}>
          <p className="mt-6 text-lg leading-relaxed text-sepia">{entrada}</p>
        </Reveal>
      )}

      <div className="mt-14 flex flex-col gap-10">
        {secciones.map((s, i) => (
          <Reveal key={s.titulo} retraso={0.1 + i * 0.05}>
            <section className="border-t border-linea pt-8">
              <h2 className="text-xl font-bold tracking-tight">{s.titulo}</h2>
              <div className="mt-4 flex flex-col gap-4">
                {s.parrafos.map((p, j) => (
                  <p key={j} className="leading-relaxed text-sepia">
                    {p}
                  </p>
                ))}
              </div>
            </section>
          </Reveal>
        ))}
      </div>

      {pie && (
        <Reveal retraso={0.2}>
          <p className="mt-12 border-t border-linea pt-6 font-mono text-[11px] uppercase tracking-[0.14em] text-sepia">
            {pie}
          </p>
        </Reveal>
      )}
    </div>
  );
}
