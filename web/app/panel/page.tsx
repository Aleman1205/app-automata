"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus } from "lucide-react";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Estado } from "@/components/ui/estado";
import { Boton } from "@/components/ui/boton";
import { Avatar } from "@/components/ui/avatar";
import { Contador } from "@/components/motion/contador";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import {
  actividadReciente,
  automatizaciones,
  cuenta,
  equipo,
  obtenerMiembro,
  organizacion,
  usuarioActual,
  type TipoActividad,
} from "@/lib/datos";

const textoActividad: Record<TipoActividad, string> = {
  ejecucion: "ejecutó",
  ajuste: "pidió un ajuste a",
  nueva: "creó",
  invitacion: "invitó a",
};

export default function Panel() {
  const router = useRouter();
  const yo = usuarioActual();
  const nombrePila = yo.nombre.split(" ")[0];
  const activas = automatizaciones.filter(
    (a) => a.estado === "lista" || a.estado === "congelada",
  );

  return (
    <div className="mx-auto max-w-6xl px-6 pt-36 pb-24 md:pt-44">
      {/* Saludo */}
      <Reveal desenfoque={false} y={12}>
        <Etiqueta punto>
          {organizacion.nombre} · Plan {organizacion.plan}
        </Etiqueta>
      </Reveal>
      <TextoRevelado
        como="h1"
        texto={`Hola, ${nombrePila}.`}
        className="mt-4 text-5xl font-black tracking-tight md:text-7xl"
        retraso={0.1}
      />
      <Reveal retraso={0.3}>
        <p className="mt-5 text-lg text-sepia">
          Esto es lo que ha pasado en tu portafolio.
        </p>
      </Reveal>

      {/* Métricas */}
      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {[
          {
            etiqueta: "Automatizaciones activas",
            valor: cuenta.automatizacionesActivas,
            nota: `de ${cuenta.espaciosTotal} espacios`,
          },
          {
            etiqueta: "Ejecuciones este mes",
            valor: cuenta.ejecucionesMes,
            nota: `de ${cuenta.ejecucionesTotal.toLocaleString("es-MX")}`,
          },
          {
            etiqueta: "Personas en el equipo",
            valor: equipo.length,
            nota: `de ${organizacion.lugaresTotal} lugares`,
          },
        ].map((m, i) => (
          <Reveal key={m.etiqueta} retraso={0.1 + i * 0.08}>
            <Tarjeta className="flex flex-col gap-2 p-6">
              <Etiqueta>{m.etiqueta}</Etiqueta>
              <span className="text-4xl font-black tracking-tight md:text-5xl">
                <Contador valor={m.valor} formato="entero" />
              </span>
              <span className="text-sm text-sepia">{m.nota}</span>
            </Tarjeta>
          </Reveal>
        ))}
      </div>

      {/* Dos columnas: automatizaciones + actividad */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* Tus automatizaciones */}
        <Reveal retraso={0.15}>
          <Tarjeta className="flex h-full flex-col p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Tus automatizaciones</h2>
              <Link
                href="/portafolio"
                className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.14em] text-sepia transition-colors hover:text-tinta"
              >
                Ver todas
                <ArrowRight className="size-3.5" strokeWidth={2.5} />
              </Link>
            </div>
            <div className="mt-4 flex flex-col divide-y divide-linea">
              {activas.map((a) => (
                <button
                  key={a.id}
                  onClick={() => router.push(`/portafolio/${a.id}`)}
                  className="group flex items-center justify-between gap-4 py-3.5 text-left transition-colors"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold transition-colors group-hover:text-tinta">
                      {a.nombre}
                    </p>
                    <span className="text-xs text-sepia">
                      {a.ejecuciones} ejecuciones
                    </span>
                  </div>
                  <span className="flex shrink-0 items-center gap-3">
                    <Estado estado={a.estado} />
                    <ArrowRight
                      className="size-4 text-sepia transition-transform duration-300 group-hover:translate-x-1 group-hover:text-tinta"
                      strokeWidth={2.5}
                    />
                  </span>
                </button>
              ))}
              <Link
                href="/nueva"
                className="flex items-center gap-2 py-3.5 text-sm font-medium text-sepia transition-colors hover:text-tinta"
              >
                <Plus className="size-4" strokeWidth={2.5} />
                Crear una nueva
              </Link>
            </div>
          </Tarjeta>
        </Reveal>

        {/* Actividad del equipo */}
        <Reveal retraso={0.25}>
          <Tarjeta className="flex h-full flex-col p-6">
            <h2 className="text-lg font-bold">Actividad del equipo</h2>
            <div className="mt-4 flex flex-col gap-4">
              {actividadReciente.map((ev, i) => {
                const m = obtenerMiembro(ev.miembroId);
                const indice = equipo.findIndex((x) => x.id === ev.miembroId);
                if (!m) return null;
                return (
                  <div key={i} className="flex items-start gap-3">
                    <Avatar nombre={m.nombre} indice={indice} tamano="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug">
                        <span className="font-semibold">
                          {m.nombre.split(" ")[0]}
                        </span>{" "}
                        <span className="text-sepia">
                          {textoActividad[ev.tipo]}
                        </span>{" "}
                        <span className="font-medium">{ev.objeto}</span>
                      </p>
                      <span className="text-xs text-sepia">{ev.cuando}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Tarjeta>
        </Reveal>
      </div>

      {/* Banner de estado del plan */}
      <Reveal retraso={0.2}>
        <div className="mt-6 flex flex-col items-start justify-between gap-4 rounded-2xl border border-linea bg-papel p-6 sm:flex-row sm:items-center">
          <div>
            <Etiqueta>Tu plan</Etiqueta>
            <p className="mt-1.5 text-sm">
              <span className="font-bold">Plan {cuenta.plan}</span>
              <span className="text-sepia">
                {" "}· se renueva el {cuenta.proximaRenovacion}
              </span>
            </p>
          </div>
          <Boton variante="fantasma" tamano="sm" href="/cuenta" icono="flecha">
            Ver mi cuenta
          </Boton>
        </div>
      </Reveal>
    </div>
  );
}
