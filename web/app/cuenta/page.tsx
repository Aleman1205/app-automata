"use client";

import { useEffect, useState } from "react";
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
import {
  verCuenta, irAlCheckout, irAlPortalDePago,
  type CuentaVista, type PlanPagable,
} from "@/lib/automata/lectura";

// Los precios de docs/06 (MXN provisionales). Se muestran para que el cliente sepa qué va a pagar
// ANTES de ir al checkout; el importe REAL lo cobra Stripe desde su price, y si algún día no
// coinciden manda Stripe — por eso el backend rechaza un price que no mapee a su plan.
const PLANES: { id: PlanPagable; titulo: string; precio: number }[] = [
  { id: "base", titulo: "Base", precio: 499 },
  { id: "pro", titulo: "Pro", precio: 999 },
  { id: "equipo", titulo: "Equipo", precio: 1999 },
];

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

  // Plan + uso REALES (fallback a datos falsos si no hay backend). El precio/método de pago/
  // historial/perfil siguen siendo demo (eso vive en Stripe/Clerk, no en nuestro backend).
  const [real, setReal] = useState<CuentaVista | null>(null);
  const [eligiendoPlan, setEligiendoPlan] = useState(false);
  const [yendoAPagar, setYendoAPagar] = useState<PlanPagable | null>(null);
  const [abriendoPortal, setAbriendoPortal] = useState(false);
  useEffect(() => {
    verCuenta().then(setReal).catch(() => setReal(null));
  }, []);

  // Vuelta desde Stripe. El plan lo aplica el WEBHOOK, que puede tardar unos segundos en llegar, así
  // que al volver el plan de arriba todavía puede ser el viejo. Decirlo es mejor que un "¡Listo!"
  // que la pantalla contradice — o peor, que el cliente crea que no se aplicó y vuelva a pagar.
  useEffect(() => {
    const pago = new URLSearchParams(window.location.search).get("pago");
    if (!pago) return;
    if (pago === "listo") {
      avisar("Pago recibido. Tu plan nuevo se activa en unos segundos.");
      // Se relee un momento después: si el webhook ya llegó, la pantalla se corrige sola.
      const t = setTimeout(() => { verCuenta().then(setReal).catch(() => {}); }, 4000);
      window.history.replaceState({}, "", "/cuenta"); // que un refresh no repita el aviso
      return () => clearTimeout(t);
    }
    if (pago === "cancelado") {
      avisar("No se hizo ningún cargo. Sigues en tu plan de siempre.");
      window.history.replaceState({}, "", "/cuenta");
    }
  }, [avisar]);
  const c: CuentaVista = real ?? {
    plan: cuenta.plan,
    precioMes: cuenta.precioMes,
    proximaRenovacion: cuenta.proximaRenovacion,
    espaciosUsados: cuenta.automatizacionesActivas,
    espaciosTotal: cuenta.espaciosTotal,
    ejecucionesMes: cuenta.ejecucionesMes,
    ejecucionesTotal: cuenta.ejecucionesTotal,
    usuariosUsados: equipo.length,
    usuariosTotal: organizacion.lugaresTotal,
  };

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
                    Plan {c.plan}
                  </span>
                  <span className="text-sepia">
                    <span className="font-semibold text-tinta">
                      <Contador valor={c.precioMes} formato="entero" prefijo="$" />
                    </span>{" "}
                    MXN/mes
                  </span>
                </p>
                {c.proximaRenovacion && (
                  <p className="mt-1 text-sm text-sepia">
                    Se renueva el {c.proximaRenovacion}
                  </p>
                )}
              </div>
              <Boton
                variante="fantasma"
                tamano="sm"
                deshabilitado={yendoAPagar !== null}
                onClick={() => setEligiendoPlan((v) => !v)}
              >
                {eligiendoPlan ? "Cancelar" : "Cambiar de plan"}
              </Boton>
            </div>

            {/* El cambio de plan lo cobra STRIPE, no nosotros: este botón solo abre su checkout y el
                plan se aplica cuando Stripe confirma el pago (el webhook lo deriva del price). Por
                eso aquí no se toca nada del plan ni se muestra un "listo" optimista. */}
            {eligiendoPlan && (
              <div className="mt-5 flex flex-col gap-3 border-t border-linea pt-5">
                <p className="text-sm text-sepia">
                  Elige tu plan. Te llevamos al pago seguro y cobramos solo la diferencia del mes.
                </p>
                <div className="flex flex-wrap gap-2">
                  {PLANES.map((p) => {
                    const actual = p.id === c.plan;
                    return (
                      <Boton
                        key={p.id}
                        variante="fantasma"
                        tamano="sm"
                        deshabilitado={actual || yendoAPagar !== null}
                        onClick={async () => {
                          setYendoAPagar(p.id);
                          try {
                            await irAlCheckout(p.id);
                          } catch (e) {
                            avisar(e instanceof Error ? e.message : "No se pudo abrir el pago.");
                            setYendoAPagar(null);
                          }
                        }}
                      >
                        {actual
                          ? `${p.titulo} · tu plan`
                          : yendoAPagar === p.id
                            ? "Abriendo el pago…"
                            : `${p.titulo} · $${p.precio.toLocaleString("es-MX")}/mes`}
                      </Boton>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-8 flex flex-col gap-5 border-t border-linea pt-6">
              <BarraUso
                etiqueta="Automatizaciones activas"
                usado={c.espaciosUsados}
                total={c.espaciosTotal}
              />
              <BarraUso
                etiqueta="Ejecuciones este mes"
                usado={c.ejecucionesMes}
                total={c.ejecucionesTotal}
              />
              <BarraUso
                etiqueta="Personas en el equipo"
                usado={c.usuariosUsados}
                total={c.usuariosTotal}
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
                {/* Con backend real NO se inventa una tarjeta. Esta pantalla mostraba
                    "Visa terminada en 4242" —el dato falso del prototipo— a un cliente que sí paga:
                    le enseñaba una tarjeta AJENA. El método de pago vive en Stripe; hasta que el
                    portal esté cableado, se dice la verdad. */}
                <p className="mt-1 text-sm">
                  {real ? (
                    <span className="text-sepia">Lo administras desde tu recibo de pago</span>
                  ) : (
                    <>
                      {cuenta.metodoPago.tipo} terminada en{" "}
                      <span className="font-semibold tabular-nums">{cuenta.metodoPago.ultimos4}</span>
                    </>
                  )}
                </p>
              </div>
            </div>
            {/* Antes era un toast ("Actualizar pago (demo)"). Ahora abre el portal REAL de Stripe,
                que es donde de verdad vive la tarjeta: nosotros nunca vemos ni guardamos datos de
                pago. Si la org todavía no tiene suscripción, el backend responde 409 y el mensaje
                la manda a elegir plan, que es lo que necesita. */}
            <Boton
              variante="fantasma"
              tamano="sm"
              deshabilitado={abriendoPortal}
              onClick={async () => {
                setAbriendoPortal(true);
                try {
                  await irAlPortalDePago();
                } catch (e) {
                  avisar(e instanceof Error ? e.message : "No se pudo abrir el pago.");
                  setAbriendoPortal(false);
                }
              }}
            >
              {abriendoPortal ? "Abriendo…" : "Actualizar"}
            </Boton>
          </Tarjeta>
        </Reveal>

        {/* Historial de pagos */}
        <Reveal retraso={0.25}>
          <Tarjeta className="p-6">
            <h2 className="text-lg font-bold">Historial de pagos</h2>
            {/* Con backend real NO se inventan cargos. Esta lista mostraba tres pagos del negocio
                de ejemplo a un cliente que sí paga — cifras que él nunca hizo, en la pantalla donde
                más confianza necesita. El historial real vive en Stripe. */}
            {real && (
              <p className="mt-3 text-sm leading-relaxed text-sepia">
                Tus recibos te llegan por correo con cada cargo. Si necesitas una factura o el
                detalle de un pago, escríbenos y te lo mandamos.
              </p>
            )}
            <div className={`mt-4 flex-col divide-y divide-linea ${real ? "hidden" : "flex"}`}>
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
            {/* Un botón que dice "Cancelar suscripción" y solo muestra un toast es de las peores
                mentiras posibles: el cliente cree que canceló y le sigue llegando el cargo. Hasta
                que la cancelación exista de verdad, se le dice cómo hacerlo. */}
            {real ? (
              <a
                href="/contacto"
                className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-sepia underline-offset-4 transition-colors hover:text-ladrillo hover:underline"
              >
                Escríbenos para cancelar
              </a>
            ) : (
              <button
                onClick={() => avisar("Solicitud de cancelación recibida (demo)")}
                className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-sepia transition-colors hover:text-ladrillo"
              >
                Cancelar suscripción
              </button>
            )}
          </div>
        </Reveal>
      </div>

      {elemento}
    </div>
  );
}
