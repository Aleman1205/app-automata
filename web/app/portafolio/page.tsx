"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Plus } from "lucide-react";
import { Etiqueta } from "@/components/ui/etiqueta";
import { GrupoAvatares } from "@/components/ui/avatar";
import { useAviso } from "@/components/ui/aviso";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { automatizaciones, creadoPor, equipo, obtenerMiembro } from "@/lib/datos";
import {
  TarjetaAutomatizacion,
  type DatosTarjeta,
} from "./_componentes/tarjeta-automatizacion";

const ESPACIOS_TOTALES = 10; // plan Equipo

// Datos de creador para una automatización, listos para la tarjeta.
function creador(automationId: string) {
  const m = obtenerMiembro(creadoPor[automationId]);
  if (!m) return {};
  return {
    creadaPor: m.nombre,
    creadaPorIndice: equipo.findIndex((x) => x.id === m.id),
  };
}

// Estado de la "demo viva": una automatización recién pedida en /nueva que
// aparece generándose y, a los 8 segundos, queda lista frente al usuario.
interface DemoViva {
  nombre: string;
  estado: "generando" | "lista";
}

export default function PaginaPortafolio() {
  const { avisar, elemento } = useAviso();
  const [demo, setDemo] = useState<DemoViva | null>(null);
  const [celebrar, setCelebrar] = useState(false);

  useEffect(() => {
    const temporizadores: number[] = [];
    try {
      const crudo = localStorage.getItem("demo_nueva");
      if (crudo) {
        const { nombre } = JSON.parse(crudo) as { nombre?: string };
        if (nombre) {
          // Diferido con setTimeout para no llamar setState en el cuerpo
          // síncrono del efecto (regla react-hooks/set-state-in-effect).
          temporizadores.push(
            window.setTimeout(() => {
              setDemo({ nombre, estado: "generando" });
            }, 0),
          );
          temporizadores.push(
            window.setTimeout(() => {
              setDemo({ nombre, estado: "lista" });
              setCelebrar(true);
              localStorage.removeItem("demo_nueva");
            }, 8000),
          );
        }
      }
    } catch {
      // Si el dato guardado viene corrupto, simplemente no mostramos la demo.
    }
    return () => temporizadores.forEach((t) => window.clearTimeout(t));
  }, []);

  const tarjetaDemo: DatosTarjeta | null = demo
    ? {
        id: "reporte-ventas",
        nombre: demo.nombre,
        descripcion:
          demo.estado === "generando"
            ? "La estamos construyendo a partir de lo que nos contaste."
            : "Quedó lista. Entra para ejecutarla por primera vez.",
        estado: demo.estado,
        creada: "hoy",
        ejecuciones: 0,
        ajustesUsados: 0,
      }
    : null;

  // La tarjeta demo reutiliza el id "reporte-ventas": mientras exista,
  // ocultamos la automatización de lib/datos con ese id para no mostrar dos
  // tarjetas con el mismo destino ni contarla doble en los espacios.
  const visibles = tarjetaDemo
    ? automatizaciones.filter((a) => a.id !== tarjetaDemo.id)
    : automatizaciones;

  const espaciosUsados = visibles.length + (tarjetaDemo ? 1 : 0);
  const desfase = tarjetaDemo ? 1 : 0;

  return (
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-36 md:pb-32 md:pt-44">
      {/* Cabecera */}
      <div className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-5">
          <Reveal desenfoque={false} y={12}>
            <Etiqueta punto>Tu portafolio</Etiqueta>
          </Reveal>
          <TextoRevelado
            texto="Tus automatizaciones."
            como="h1"
            className="text-5xl font-black leading-[0.95] tracking-tight md:text-7xl"
          />
        </div>
        <Reveal retraso={0.2} y={16} className="flex flex-col items-start gap-4 md:items-end">
          <Link
            href="/equipo"
            className="flex items-center gap-2.5 rounded-full border border-linea bg-papel py-1.5 pl-2 pr-4 transition-colors hover:border-tinta"
          >
            <GrupoAvatares nombres={equipo.map((m) => m.nombre)} max={4} />
            <span className="text-xs text-sepia">
              Equipo de {equipo.length}
            </span>
          </Link>
          <div className="flex flex-col items-start gap-2.5 md:items-end">
            <Etiqueta>
              {espaciosUsados} de {ESPACIOS_TOTALES} espacios usados
            </Etiqueta>
            <div className="h-1 w-28 overflow-hidden rounded-full bg-linea">
              <motion.div
                className="h-full rounded-full bg-tinta"
                initial={{ width: 0 }}
                animate={{
                  width: `${(espaciosUsados / ESPACIOS_TOTALES) * 100}%`,
                }}
                transition={{
                  duration: 0.9,
                  delay: 0.4,
                  ease: [0.22, 1, 0.36, 1],
                }}
              />
            </div>
          </div>
        </Reveal>
      </div>

      {/* Grid de automatizaciones */}
      <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {tarjetaDemo && (
          <Reveal className="h-full">
            <TarjetaAutomatizacion
              datos={tarjetaDemo}
              recienCreada={demo?.estado === "lista"}
              celebrar={celebrar}
              alAvisar={avisar}
            />
          </Reveal>
        )}

        {visibles.map((a, i) => (
          <Reveal
            key={a.id}
            retraso={(i + desfase) * 0.08}
            className="h-full"
          >
            <TarjetaAutomatizacion
              datos={{ ...a, ...creador(a.id) }}
              alAvisar={avisar}
            />
          </Reveal>
        ))}

        {/* Tarjeta fantasma: nueva automatización */}
        <Reveal
          retraso={(visibles.length + desfase) * 0.08}
          className="h-full"
        >
          <Link
            href="/nueva"
            className="flex h-full min-h-56 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-linea p-6 text-sepia transition-colors duration-300 hover:border-tinta hover:text-tinta"
          >
            <Plus className="size-9" strokeWidth={1.5} />
            <span className="font-semibold">Nueva automatización</span>
          </Link>
        </Reveal>
      </div>

      {elemento}
    </div>
  );
}
