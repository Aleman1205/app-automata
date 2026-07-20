"use client";

import { CreditCard, Check } from "lucide-react";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Boton } from "@/components/ui/boton";
import { Avatar } from "@/components/ui/avatar";
import { Contador } from "@/components/motion/contador";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { useAviso } from "@/components/ui/aviso";
import {
  cuenta,
  equipo,
  organizacion,
  pagos,
  usuarioActual,
} from "@/lib/datos";

// Barra de uso: llenado animado con etiqueta "X de Y".
function BarraUso({
  etiqueta,
  usado,
  total,
  sufijo = "",
}: {
  etiqueta: string;
  usado: number;
  total: number;
  sufijo?: string;
}) {
  const pct = Math.min(100, (usado / total) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{etiqueta}</span>
        <span className="font-mono text-sm text-sepia tabular-nums">
          {usado.toLocaleString("es-MX")} / {total.toLocaleString("es-MX")}
          {sufijo}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-linea">
        <div
          className="h-full rounded-full bg-tinta transition-[width] duration-1000 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function Cuenta() {
  const { avisar, elemento } = useAviso();
  const yo = usuarioActual();

  return (
    <div className="mx-auto max-w-4xl px-6 pt-36 pb-24 md:pt-44">
      <Reveal desenfoque={false} y={12}>
        <Etiqueta punto>{organizacion.nombre}</Etiqueta>
      </Reveal>
      <TextoRevelado
        como="h1"
        texto="Tu cuenta."
        className="mt-4 text-5xl font-black tracking-tight md:text-7xl"
        retraso={0.1}
      />

      <div className="mt-12 flex flex-col gap-6">
        {/* Perfil */}
        <Reveal retraso={0.1}>
          <Tarjeta className="flex items-center gap-4 p-6">
            <Avatar nombre={yo.nombre} tamano="lg" />
            <div className="min-w-0 flex-1">
              <p className="font-bold">{yo.nombre}</p>
              <span className="text-sm text-sepia">{yo.correo}</span>
            </div>
            <span className="hidden font-mono text-[11px] uppercase tracking-[0.14em] text-sepia sm:inline">
              Administrador
            </span>
          </Tarjeta>
        </Reveal>

        {/* Plan + uso */}
        <Reveal retraso={0.15}>
          <Tarjeta className="p-6">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <Etiqueta>Plan actual</Etiqueta>
                <p className="mt-1.5 flex items-baseline gap-2">
                  <span className="text-3xl font-black tracking-tight">
                    Plan {cuenta.plan}
                  </span>
                  <span className="text-sepia">
                    <span className="font-semibold text-tinta">
                      <Contador valor={cuenta.precioMes} formato="entero" prefijo="$" />
                    </span>{" "}
                    MXN/mes
                  </span>
                </p>
                <p className="mt-1 text-sm text-sepia">
                  Se renueva el {cuenta.proximaRenovacion}
                </p>
              </div>
              <Boton
                variante="fantasma"
                tamano="sm"
                onClick={() => avisar("Cambio de plan (demo)")}
              >
                Cambiar de plan
              </Boton>
            </div>

            <div className="mt-8 flex flex-col gap-5 border-t border-linea pt-6">
              <BarraUso
                etiqueta="Automatizaciones activas"
                usado={cuenta.automatizacionesActivas}
                total={cuenta.espaciosTotal}
              />
              <BarraUso
                etiqueta="Ejecuciones este mes"
                usado={cuenta.ejecucionesMes}
                total={cuenta.ejecucionesTotal}
              />
              <BarraUso
                etiqueta="Personas en el equipo"
                usado={equipo.length}
                total={organizacion.lugaresTotal}
              />
            </div>
          </Tarjeta>
        </Reveal>

        {/* Método de pago */}
        <Reveal retraso={0.2}>
          <Tarjeta className="flex items-center justify-between gap-4 p-6">
            <div className="flex items-center gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-linea bg-papel">
                <CreditCard className="size-5 text-tinta" strokeWidth={2} />
              </span>
              <div>
                <Etiqueta>Método de pago</Etiqueta>
                <p className="mt-1 text-sm">
                  {cuenta.metodoPago.tipo} terminada en{" "}
                  <span className="font-semibold tabular-nums">
                    {cuenta.metodoPago.ultimos4}
                  </span>
                </p>
              </div>
            </div>
            <Boton
              variante="fantasma"
              tamano="sm"
              onClick={() => avisar("Actualizar pago (demo)")}
            >
              Actualizar
            </Boton>
          </Tarjeta>
        </Reveal>

        {/* Historial de pagos */}
        <Reveal retraso={0.25}>
          <Tarjeta className="p-6">
            <h2 className="text-lg font-bold">Historial de pagos</h2>
            <div className="mt-4 flex flex-col divide-y divide-linea">
              {pagos.map((p, i) => (
                <div key={i} className="flex items-center justify-between gap-4 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.concepto}</p>
                    <span className="text-xs text-sepia">{p.fecha}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <span className="font-semibold tabular-nums">
                      ${p.monto.toLocaleString("es-MX")}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-oliva">
                      <Check className="size-3.5" strokeWidth={3} />
                      {p.estado}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Tarjeta>
        </Reveal>

        {/* Cancelar */}
        <Reveal retraso={0.3}>
          <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-linea p-6 sm:flex-row sm:items-center">
            <div>
              <p className="font-semibold">¿Cancelar tu suscripción?</p>
              <p className="mt-1 text-sm text-sepia">
                Conservas acceso de solo lectura 30 días para descargar todo.
              </p>
            </div>
            <button
              onClick={() => avisar("Solicitud de cancelación recibida (demo)")}
              className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-sepia transition-colors hover:text-ladrillo"
            >
              Cancelar suscripción
            </button>
          </div>
        </Reveal>
      </div>

      {elemento}
    </div>
  );
}
