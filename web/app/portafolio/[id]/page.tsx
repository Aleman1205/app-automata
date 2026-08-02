"use client";

import { use, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Lock, Upload } from "lucide-react";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Estado } from "@/components/ui/estado";
import { PuntosAjustes } from "@/components/ui/puntos-ajustes";
import { Resultado } from "@/components/ui/resultado";
import { Boton } from "@/components/ui/boton";
import { useAviso } from "@/components/ui/aviso";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { CheckDibujado } from "@/components/motion/check-dibujado";
import {
  obtenerAutomatizacion,
  type Automatizacion,
  type EntradaManifiesto,
  type ResultadoDemo,
} from "@/lib/datos";
import {
  verAutomatizacion,
  ejecutarArchivo,
  congelarAutomatizacion,
} from "@/lib/automata/lectura";
import { Volver } from "../_componentes/volver";
import { TablaHistorial } from "../_componentes/tabla-historial";
import { TimelineCambios } from "../_componentes/timeline-cambios";

// Scroll suave con el lenis global del layout (sin declarar tipos globales).
type Lenis = {
  scrollTo: (destino: HTMLElement, opciones?: { offset?: number }) => void;
};

// Textos genéricos: sirven para cualquier automatización, sin cifras que
// puedan contradecir las métricas del resultado.
const PASOS_EJECUCION = [
  "Validando tu archivo…",
  "Procesando tu información…",
  "Generando tu resultado…",
];

const EASING: [number, number, number, number] = [0.22, 1, 0.36, 1];

// El nombre real del archivo que se baja. Se conserva la base que puso el agente ("dashboard.xlsx"
// → "dashboard.json") para que el cliente reconozca cuál es, pero la extensión dice la verdad.
function nombreDescarga(archivoSalida?: string): string {
  const base = (archivoSalida ?? "").trim().replace(/\.[^./\\]+$/, "");
  return `${base.length > 0 ? base : "resultado"}.json`;
}

function Girador() {
  return (
    <svg
      className="size-4 shrink-0 animate-spin text-sepia"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
        className="opacity-20"
      />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Dropzone compacta. En modo demo un clic simula la subida; en modo real (onArchivo) abre un
// selector de archivo de verdad y captura el File para el Run.
function ZonaArchivo({
  entrada,
  cargado,
  alCargar,
  onArchivo,
  nombreCargado,
}: {
  entrada: EntradaManifiesto;
  cargado: boolean;
  alCargar: () => void;
  onArchivo?: (archivo: File) => void;
  nombreCargado?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = entrada.formatos?.map((f) => `.${f}`).join(",");
  return (
    <>
      {onArchivo && (
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              onArchivo(f);
              alCargar();
            }
          }}
        />
      )}
      <button
        type="button"
        onClick={onArchivo ? () => inputRef.current?.click() : alCargar}
        className={`flex w-full items-center gap-4 rounded-xl border-2 border-dashed px-5 py-4 text-left transition-colors duration-300 ${
          cargado
            ? "border-oliva/60 bg-papel"
            : "border-linea hover:border-tinta"
        }`}
      >
        {cargado ? (
          <CheckDibujado tamano={30} />
        ) : (
          <Upload className="size-5 shrink-0 text-sepia" strokeWidth={2} />
        )}
        <span className="flex flex-col gap-0.5">
          {cargado ? (
            <>
              <span className="font-mono text-sm font-semibold">
                {nombreCargado ??
                  entrada.ejemploNombre ??
                  `${entrada.id}-marzo.${entrada.formatos?.[0] ?? "xlsx"}`}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-oliva">
                {entrada.multiple ? "Archivos listos" : "Archivo listo"}
              </span>
            </>
          ) : (
            <>
              <span className="text-sm font-semibold">{entrada.etiqueta}</span>
              <span className="text-xs text-sepia">
                {entrada.ayuda ??
                  (entrada.multiple
                    ? "Haz clic para elegir tus archivos"
                    : "Haz clic para elegir tu archivo")}
                {entrada.formatos && (
                  <span className="ml-2 font-mono uppercase tracking-[0.12em]">
                    {entrada.formatos.join(" · ")}
                  </span>
                )}
              </span>
            </>
          )}
        </span>
      </button>
    </>
  );
}

export default function PaginaDetalle({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { avisar, elemento } = useAviso();

  // Modo REAL: un id con forma de uuid viene del portafolio real (los ids demo no lo son) → traemos
  // el detalle del API (que resuelve la org del usuario vía /api/yo). Si no hay backend/org, el
  // fetch devuelve null → "no encontrada". Modo demo (ids no-uuid): datos falsos.
  const esReal = /^[0-9a-fA-F-]{36}$/.test(id);
  const fakeA = obtenerAutomatizacion(id);
  // undefined = cargando (real); null = sin backend / no encontrada; objeto = detalle real.
  const [detalleReal, setDetalleReal] = useState<Automatizacion | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!esReal) {
      setDetalleReal(null);
      return;
    }
    // Igual que el portafolio: mientras se esté construyendo (build inicial o un ajuste que
    // el cliente acaba de pedir) se refresca, y se para en cuanto queda lista. Sin esto el
    // cliente se queda mirando "generando…" aunque el build ya terminó.
    let vivo = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const cargar = async () => {
      const d = await verAutomatizacion(id).catch(() => null);
      if (!vivo) return;
      setDetalleReal(d);
      if (d?.estado === "generando") t = setTimeout(cargar, 10_000);
    };
    void cargar();
    return () => { vivo = false; if (t) clearTimeout(t); };
  }, [id, esReal]);
  const a = esReal ? detalleReal : fakeA;
  const cargandoReal = esReal && detalleReal === undefined;

  // Estado del Run REAL (archivo subido → resultado resuelto del backend).
  const [archivoReal, setArchivoReal] = useState<File | null>(null);
  const [resultadoReal, setResultadoReal] = useState<ResultadoDemo | null>(null);
  const [errorRun, setErrorRun] = useState<string | null>(null);

  // Archivos y selecciones del formulario de ejecución (demo)
  const [archivos, setArchivos] = useState<Record<string, boolean>>({});
  const [selecciones, setSelecciones] = useState<Record<string, string>>(() => {
    const inicial: Record<string, string> = {};
    fakeA?.entradas.forEach((en) => {
      if (en.tipo === "seleccion" && en.opciones?.length) {
        inicial[en.id] = en.opciones[0].valor;
      }
    });
    return inicial;
  });

  // Ejecución en vivo
  const [fase, setFase] = useState<"quieta" | "corriendo" | "hecha">("quieta");
  const [paso, setPaso] = useState(0);
  const temporizadores = useRef<number[]>([]);
  const refResultado = useRef<HTMLElement | null>(null);

  // Congelar localmente ("hacerla definitiva")
  const [congeladaLocal, setCongeladaLocal] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  useEffect(() => {
    const pendientes = temporizadores.current;
    return () => pendientes.forEach((t) => window.clearTimeout(t));
  }, []);

  // Cargando el detalle real: no mostramos aún la guarda de "no encontrada".
  if (cargandoReal) {
    return (
      <div className="mx-auto max-w-5xl px-6 pb-24 pt-36 md:pb-32 md:pt-44">
        <Etiqueta punto>Tu portafolio</Etiqueta>
        <p className="mt-6 text-sepia">Cargando…</p>
      </div>
    );
  }

  // ── Guardas: id inexistente, generando o con fallo ────────────────────────
  if (!a || a.estado === "generando" || a.estado === "fallo") {
    const mensaje = !a
      ? "No encontramos esta automatización. Puede que el enlace esté incompleto."
      : a.estado === "generando"
        ? "La estamos construyendo. Te avisaremos por correo cuando esté lista."
        : "Esta no quedó a la primera. Desde tu portafolio puedes reintentar gratis.";
    return (
      <div className="mx-auto max-w-5xl px-6 pb-24 pt-36 md:pb-32 md:pt-44">
        <Reveal className="flex flex-col items-start gap-6">
          <Etiqueta punto>Tu portafolio</Etiqueta>
          <TextoRevelado
            texto={!a ? "Aquí no hay nada todavía." : "Esta aún no se puede abrir."}
            como="h1"
            className="text-5xl font-black leading-[0.95] tracking-tight md:text-7xl"
          />
          <p className="max-w-xl leading-relaxed text-sepia">{mensaje}</p>
          <Boton variante="oscuro" icono="flecha" href="/portafolio">
            Volver al portafolio
          </Boton>
        </Reveal>
      </div>
    );
  }

  const estadoEfectivo = congeladaLocal ? "congelada" : a.estado;
  const entradasArchivo = a.entradas.filter((en) => en.tipo === "archivo");
  const listaParaEjecutar = esReal
    ? archivoReal !== null
    : entradasArchivo.length > 0 && entradasArchivo.every((en) => archivos[en.id]);
  // El resultado a mostrar: en real, el de la corrida; en demo, el fijo del prototipo.
  const resultadoMostrar: ResultadoDemo | null = esReal
    ? resultadoReal
    : a.resultado ?? null;
  const mostrarResultado = esReal
    ? resultadoReal !== null
    : Boolean(a.resultado) && (a.ejecuciones > 0 || fase === "hecha");

  const irAlResultado = () => {
    window.setTimeout(() => {
      if (refResultado.current) {
        const lenis = (window as Window & { __lenis?: Lenis }).__lenis;
        lenis?.scrollTo(refResultado.current, { offset: -120 });
      }
    }, 200);
  };

  const ejecutar = async () => {
    // Modo REAL: sube el archivo, corre en el backend y muestra el Resultado resuelto.
    if (esReal) {
      if (!archivoReal || !a) return;
      setErrorRun(null);
      setFase("corriendo");
      setPaso(1); // avanza los pasos visibles mientras corre (el Run es de milisegundos)
      try {
        const { resultado } = await ejecutarArchivo(a.id, archivoReal);
        setResultadoReal(resultado);
        setPaso(PASOS_EJECUCION.length);
        setFase("hecha");
        irAlResultado();
      } catch (e) {
        setErrorRun(e instanceof Error ? e.message : "No se pudo ejecutar.");
        setFase("quieta");
      }
      return;
    }
    // Modo demo: animación simulada.
    setFase("corriendo");
    setPaso(0);
    const t1 = window.setTimeout(() => setPaso(1), 1100);
    const t2 = window.setTimeout(() => setPaso(2), 2200);
    const t3 = window.setTimeout(() => setPaso(3), 3300);
    const t4 = window.setTimeout(() => {
      setFase("hecha");
      irAlResultado();
    }, 3600);
    temporizadores.current.push(t1, t2, t3, t4);
  };

  const congelar = async () => {
    setConfirmando(false);
    // Modo REAL: congela en el backend (app_congelar); si tiene un cambio en curso, avisa.
    if (esReal && a) {
      try {
        await congelarAutomatizacion(a.id);
        setCongeladaLocal(true);
        avisar("Automatización definitiva");
      } catch (e) {
        avisar(e instanceof Error ? e.message : "No se pudo hacer definitiva");
      }
      return;
    }
    setCongeladaLocal(true);
    avisar("Automatización definitiva");
  };

  // Descarga el resultado: en real baja el JSON de verdad; en demo solo avisa.
  // El nombre SIEMPRE termina en .json porque es lo que realmente se serializa. Antes usaba
  // archivoSalida tal cual (p.ej. "dashboard.xlsx"), así que el cliente bajaba un .xlsx que era
  // JSON adentro y Excel se lo rechazaba como archivo corrupto. El .xlsx de verdad lo escribe el
  // script en el runner y hoy no se conserva — hasta que se conserve, no se puede ofrecer.
  const descargar = () => {
    if (esReal && resultadoMostrar) {
      const blob = new Blob([JSON.stringify(resultadoMostrar, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = nombreDescarga(resultadoMostrar.archivoSalida);
      enlace.click();
      URL.revokeObjectURL(url);
      return;
    }
    avisar("Descargado (demo)");
  };

  return (
    <div className="mx-auto max-w-5xl px-6 pb-24 pt-36 md:pb-32 md:pt-44">
      <Reveal desenfoque={false} y={10}>
        <Volver href="/portafolio" />
      </Reveal>

      {/* ── Cabecera ── */}
      <header className="mt-10 flex flex-col gap-6">
        <TextoRevelado
          texto={a.nombre}
          como="h1"
          className="text-5xl font-black leading-[0.95] tracking-tight md:text-7xl"
        />
        <Reveal retraso={0.15} y={14}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Estado estado={estadoEfectivo} />
            <Etiqueta>Creada {a.creada}</Etiqueta>
            <Etiqueta>{a.ejecuciones} ejecuciones</Etiqueta>
            <PuntosAjustes usados={a.ajustesUsados} />
          </div>
        </Reveal>
        <div className="border-t border-linea" />
        <Reveal retraso={0.2} y={14}>
          <p className="max-w-2xl text-base leading-relaxed text-sepia md:text-lg">
            {a.descripcion}
          </p>
        </Reveal>
      </header>

      {/* ── Ejecutar ── */}
      <section className="mt-14">
        <Reveal>
          <Tarjeta className="flex flex-col gap-8 p-6 md:p-10">
            <TextoRevelado
              texto="Ejecutar ahora"
              como="h2"
              className="text-3xl font-black tracking-tight md:text-5xl"
            />

            <div className="flex flex-col gap-6">
              {a.entradas.map((en) =>
                en.tipo === "archivo" ? (
                  <div key={en.id} className="flex flex-col gap-2.5">
                    <Etiqueta>{en.etiqueta}</Etiqueta>
                    <ZonaArchivo
                      entrada={en}
                      cargado={Boolean(archivos[en.id])}
                      alCargar={() =>
                        setArchivos((prev) => ({ ...prev, [en.id]: true }))
                      }
                      onArchivo={esReal ? setArchivoReal : undefined}
                      nombreCargado={esReal ? archivoReal?.name : undefined}
                    />
                  </div>
                ) : (
                  <div key={en.id} className="flex flex-col gap-2.5">
                    <Etiqueta>{en.etiqueta}</Etiqueta>
                    <div className="flex flex-wrap gap-2">
                      {en.opciones?.map((op) => {
                        const activa = selecciones[en.id] === op.valor;
                        return (
                          <button
                            key={op.valor}
                            type="button"
                            onClick={() =>
                              setSelecciones((prev) => ({
                                ...prev,
                                [en.id]: op.valor,
                              }))
                            }
                            className={`relative rounded-full border px-4 py-2 text-sm font-medium transition-colors duration-300 ${
                              activa
                                ? "border-tinta text-crema"
                                : "border-linea text-tinta hover:border-tinta"
                            }`}
                          >
                            {activa && (
                              <motion.span
                                layoutId={`pastilla-${en.id}`}
                                className="absolute inset-0 rounded-full bg-tinta"
                                transition={{
                                  type: "spring",
                                  stiffness: 350,
                                  damping: 30,
                                }}
                              />
                            )}
                            <span className="relative">{op.etiqueta}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ),
              )}
            </div>

            <AnimatePresence mode="wait">
              {fase === "quieta" ? (
                <motion.div
                  key="boton-ejecutar"
                  exit={{ opacity: 0, x: -24 }}
                  transition={{ duration: 0.35, ease: EASING }}
                >
                  <Boton
                    variante="acento"
                    tamano="lg"
                    icono="play"
                    deshabilitado={!listaParaEjecutar}
                    onClick={ejecutar}
                  >
                    Ejecutar ahora
                  </Boton>
                  {!listaParaEjecutar && (
                    <p className="mt-3 text-xs text-sepia">
                      Sube {entradasArchivo.length > 1 ? "tus archivos" : "tu archivo"} para poder ejecutar.
                    </p>
                  )}
                  {errorRun && (
                    <p className="mt-3 text-sm text-ladrillo">{errorRun}</p>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="pasos-ejecucion"
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.45, ease: EASING }}
                  className="flex flex-col gap-3.5 rounded-xl border border-linea bg-papel p-5"
                >
                  <AnimatePresence>
                    {PASOS_EJECUCION.slice(
                      0,
                      Math.min(paso + 1, PASOS_EJECUCION.length),
                    ).map((texto, i) => (
                      <motion.div
                        key={texto}
                        initial={{ opacity: 0, x: 24 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.4, ease: EASING }}
                        className="flex items-center gap-3"
                      >
                        {i < paso ? (
                          <Check
                            className="size-4 shrink-0 text-oliva"
                            strokeWidth={3}
                          />
                        ) : (
                          <Girador />
                        )}
                        <span
                          className={`text-sm ${
                            i < paso ? "text-tinta" : "text-sepia"
                          }`}
                        >
                          {texto}
                        </span>
                      </motion.div>
                    ))}
                    {fase === "hecha" && (
                      <motion.div
                        key="hecho"
                        initial={{ opacity: 0, x: 24 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.4, ease: EASING }}
                        className="flex items-center gap-3 border-t border-linea pt-3.5"
                      >
                        <Check
                          className="size-4 shrink-0 text-oliva"
                          strokeWidth={3}
                        />
                        <span className="text-sm font-semibold">
                          Listo — aquí abajo está tu resultado.
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </Tarjeta>
        </Reveal>
      </section>

      {/* ── Resultado ── */}
      {mostrarResultado && resultadoMostrar && (
        <section ref={refResultado} className="mt-16 flex flex-col gap-10">
          <Reveal desenfoque={false}>
            <Etiqueta>
              {fase === "hecha"
                ? "Resultado — ahora mismo"
                : `Último resultado — ${a.ultimaEjecucion}`}
            </Etiqueta>
          </Reveal>

          <Resultado bloques={resultadoMostrar.bloques} />

          <Reveal>
            <div className="flex flex-wrap items-center gap-3">
              <Boton
                variante="oscuro"
                icono="descarga"
                onClick={descargar}
              >
                {`Descargar ${esReal ? nombreDescarga(resultadoMostrar.archivoSalida) : resultadoMostrar.archivoSalida}`}
              </Boton>
              {/* El .csv ya NO se baja desde aquí: cada tabla trae el suyo, junto a la tabla. Este
                  botón exportaba solo la PRIMERA, y en una conciliación —conciliados, en-banco-no-
                  en-registro, en-registro-no-en-banco, diferencias— el cliente se llevaba una de
                  cuatro sin enterarse de que faltaban tres. Ver components/ui/resultado.tsx. */}
            </div>
          </Reveal>
        </section>
      )}

      {/* ── Historial de ejecuciones ── */}
      {a.historial.length > 0 && (
        <section className="mt-16">
          <Reveal className="flex flex-col gap-6">
            <TextoRevelado
              texto="Ejecuciones anteriores"
              como="h2"
              className="text-3xl font-black tracking-tight md:text-5xl"
            />
            <TablaHistorial historial={a.historial} />
          </Reveal>
        </section>
      )}

      {/* ── Zona de ajustes ── */}
      <section className="mt-16">
        <Reveal>
          <Tarjeta className="bg-papel p-6 md:p-10">
            <AnimatePresence mode="wait">
              {estadoEfectivo === "congelada" ? (
                <motion.div
                  key="zona-congelada"
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -24 }}
                  transition={{ duration: 0.45, ease: EASING }}
                  className="flex flex-col gap-8"
                >
                  <div className="flex items-start gap-3">
                    <Lock className="mt-0.5 size-5 shrink-0" strokeWidth={2} />
                    <p className="font-semibold leading-relaxed">
                      Definitiva — ya no se modifica, pero se ejecuta con
                      normalidad.
                    </p>
                  </div>
                  <TimelineCambios cambios={a.cambios} />
                </motion.div>
              ) : (
                <motion.div
                  key="zona-lista"
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -24 }}
                  transition={{ duration: 0.45, ease: EASING }}
                  className="flex flex-col items-start gap-6"
                >
                  <PuntosAjustes usados={a.ajustesUsados} tamano="lg" />
                  <p className="max-w-xl leading-relaxed text-sepia">
                    Cada automatización incluye hasta 3 ajustes. Las
                    reparaciones — cuando algo deja de funcionar solo — son
                    gratis y no cuentan.
                  </p>
                  <div className="flex flex-wrap items-center gap-5">
                    <Boton
                      variante="fantasma"
                      href={`/portafolio/${id}/ajustar`}
                    >
                      Pedir un cambio
                    </Boton>
                    <button
                      type="button"
                      onClick={() => setConfirmando(true)}
                      className="text-sm text-sepia underline-offset-4 transition-colors duration-300 hover:text-tinta hover:underline"
                    >
                      Esta ya quedó — hacerla definitiva
                    </button>
                  </div>
                  <AnimatePresence>
                    {confirmando && (
                      <motion.div
                        key="confirmar-definitiva"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.4, ease: EASING }}
                        className="w-full overflow-hidden"
                      >
                        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-linea bg-hueso p-5">
                          <p className="text-sm font-semibold">
                            ¿De verdad? Ya no podrás pedir cambios, pero se
                            seguirá ejecutando igual.
                          </p>
                          <div className="flex items-center gap-3">
                            <Boton
                              variante="oscuro"
                              tamano="sm"
                              onClick={congelar}
                            >
                              Sí, hacerla definitiva
                            </Boton>
                            <Boton
                              variante="fantasma"
                              tamano="sm"
                              onClick={() => setConfirmando(false)}
                            >
                              No, todavía no
                            </Boton>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </Tarjeta>
        </Reveal>
      </section>

      {/* ── Historial de cambios (solo "lista" con más de una versión) ── */}
      {estadoEfectivo === "lista" && a.cambios.length > 1 && (
        <section className="mt-16">
          <Reveal>
            <TimelineCambios cambios={a.cambios} />
          </Reveal>
        </section>
      )}

      {elemento}
    </div>
  );
}
