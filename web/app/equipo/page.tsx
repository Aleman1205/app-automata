"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Mail, Shield, ShieldCheck, UserPlus, X } from "lucide-react";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Boton } from "@/components/ui/boton";
import { Avatar } from "@/components/ui/avatar";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { useAviso } from "@/components/ui/aviso";
import {
  equipo as equipoInicial,
  organizacion,
  usuarioActualId,
  type Miembro,
  type RolMiembro,
} from "@/lib/datos";
import { listarEquipo, invitarMiembro, quitarMiembro, verCuenta } from "@/lib/automata/lectura";

const etiquetaRol: Record<RolMiembro, string> = {
  admin: "Administrador",
  operador: "Operador",
};

// El miembro que muestra la UI: los datos falsos ya traen nombre/correo/estado; el flag
// `esTu` (quién soy) sale del API en modo real, o del id fijo en modo demo.
type MiembroUI = Miembro & { esTu: boolean };

export default function Equipo() {
  const { avisar, elemento } = useAviso();
  // null = aún cargando. Empezamos SIN roster (no mostramos falsos y luego reales): al montar
  // pedimos el real; si el backend responde, ese; si no hay backend, caemos a los datos falsos.
  const seedFake = (): MiembroUI[] =>
    equipoInicial.map((m) => ({ ...m, esTu: m.id === usuarioActualId }));
  const [miembros, setMiembros] = useState<MiembroUI[] | null>(null);
  // ¿el backend respondió con datos reales? Ya no depende de una env: es true si listarEquipo()
  // (que resuelve la org del usuario vía /api/yo) devolvió roster. Gate de invitar/quitar reales.
  const [esReal, setEsReal] = useState(false);
  // Límites del plan real (null hasta que responda /cuenta, o si no hay backend).
  const [plan, setPlan] = useState<{ nombre: string; usuariosTotal: number } | null>(null);
  const [invitando, setInvitando] = useState(false);
  const [correo, setCorreo] = useState("");
  const [rolNuevo, setRolNuevo] = useState<RolMiembro>("operador");

  // Roster REAL desde el API (modo dev/prod). El backend solo da user_id+rol+esTu (sin
  // nombre/correo — eso es Clerk); lectura.ts prettifica el id. Si no hay backend, datos
  // falsos. Invitar/quitar siguen siendo demo local (la mutación real exige MFA).
  useEffect(() => {
    listarEquipo()
      .then((reales) => {
        setEsReal(!!reales);
        setMiembros(reales ? reales.map((m) => ({ ...m, estado: m.pendiente ? ("pendiente" as const) : ("activo" as const) })) : seedFake());
      })
      .catch(() => setMiembros(seedFake()));
    verCuenta()
      .then((c) => { if (c) setPlan({ nombre: c.plan, usuariosTotal: c.usuariosTotal }); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refrescar = () =>
    listarEquipo()
      .then((reales) => {
        if (reales) setMiembros(reales.map((m) => ({ ...m, estado: m.pendiente ? ("pendiente" as const) : ("activo" as const) })));
      })
      .catch(() => {});

  const lista = miembros ?? [];
  const soyAdmin = lista.find((m) => m.esTu)?.rol === "admin";
  const usados = lista.length;
  // Los lugares del PLAN REAL (el dato falso decía 10 para todos; con plan base, que da 1, la
  // pantalla invitaba a llenar 10 asientos y cada intento moría con CUOTA_EXCEDIDA sin explicación).
  const lugaresTotal = plan?.usuariosTotal ?? organizacion.lugaresTotal;
  const restantes = lugaresTotal - usados;

  const invitar = async () => {
    if (!correo.trim()) return;
    if (esReal) {
      // Se invita por CORREO: queda pendiente hasta que esa persona se registre con él (el user_id
      // real lo asigna Clerk en ese momento).
      try {
        await invitarMiembro(correo.trim().toLowerCase(), rolNuevo);
        setCorreo("");
        setInvitando(false);
        avisar("Invitación enviada");
        refrescar();
      } catch (e) {
        avisar(e instanceof Error ? e.message : "No se pudo invitar");
      }
      return;
    }
    const nombre = correo
      .split("@")[0]
      .replace(/[._]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    setMiembros((prev) => [
      ...(prev ?? []),
      {
        id: `nuevo-${(prev ?? []).length}`,
        nombre,
        correo: correo.trim(),
        rol: rolNuevo,
        estado: "pendiente",
        esTu: false,
      },
    ]);
    setCorreo("");
    setInvitando(false);
    avisar("Invitación enviada por correo");
  };

  const quitar = async (id: string) => {
    if (esReal) {
      try {
        await quitarMiembro(id);
        avisar("Persona removida del equipo");
        refrescar();
      } catch (e) {
        avisar(e instanceof Error ? e.message : "No se pudo quitar");
      }
      return;
    }
    setMiembros((prev) => (prev ?? []).filter((m) => m.id !== id));
    avisar("Persona removida del equipo");
  };

  return (
    <div className="mx-auto max-w-4xl px-6 pt-36 pb-24 md:pt-44">
      {/* Cabecera */}
      <Reveal>
        <Etiqueta punto>
          {organizacion.nombre} · Plan {plan?.nombre ?? organizacion.plan}
        </Etiqueta>
      </Reveal>
      <TextoRevelado
        como="h1"
        texto="Tu equipo."
        className="mt-4 text-5xl font-black tracking-tight md:text-7xl"
        retraso={0.1}
      />
      <Reveal retraso={0.3}>
        <p className="mt-5 max-w-lg text-lg leading-relaxed text-sepia">
          Todas las personas del equipo comparten el mismo portafolio: ven y
          ejecutan las mismas automatizaciones. Solo los administradores pueden
          crearlas, ajustarlas o invitar gente.
        </p>
      </Reveal>

      {/* Indicador de lugares */}
      <Reveal retraso={0.4}>
        <div className="mt-10 flex items-center justify-between gap-4 rounded-2xl border border-linea bg-papel p-5">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              {Array.from({ length: lugaresTotal }).map((_, i) => (
                <span
                  key={i}
                  className={`h-6 w-2 rounded-full ${
                    i < usados ? "bg-tinta" : "border border-sepia/40 bg-transparent"
                  }`}
                />
              ))}
            </span>
            <span className="text-sm">
              <span className="font-bold">{usados}</span>
              <span className="text-sepia"> de {lugaresTotal} lugares usados</span>
            </span>
          </div>
          {soyAdmin && (
            <Boton
              variante="acento"
              tamano="sm"
              icono="mas"
              deshabilitado={restantes <= 0 || invitando}
              onClick={() => setInvitando(true)}
            >
              Invitar
            </Boton>
          )}
        </div>
      </Reveal>

      {/* Formulario de invitación (inline) */}
      <AnimatePresence>
        {invitando && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-4 rounded-2xl border border-tinta bg-hueso p-5">
              <div className="flex items-center justify-between">
                <Etiqueta>Invitar a alguien nuevo</Etiqueta>
                <button
                  onClick={() => setInvitando(false)}
                  className="text-sepia transition-colors hover:text-tinta"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Mail className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-sepia" />
                  <input
                    type="email"
                    value={correo}
                    onChange={(e) => setCorreo(e.target.value)}
                    placeholder="correo@tunegocio.mx"
                    className="w-full rounded-xl border border-linea bg-crema py-3 pr-4 pl-11 text-sm transition focus:border-tinta focus:outline-none"
                  />
                </div>
                <div className="flex rounded-xl border border-linea bg-crema p-1">
                  {(["operador", "admin"] as RolMiembro[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => setRolNuevo(r)}
                      className={`relative rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                        rolNuevo === r ? "text-hueso" : "text-sepia"
                      }`}
                    >
                      {rolNuevo === r && (
                        <motion.span
                          layoutId="rol-pill"
                          className="absolute inset-0 rounded-lg bg-noche"
                          transition={{ type: "spring", stiffness: 400, damping: 32 }}
                        />
                      )}
                      <span className="relative z-10">{etiquetaRol[r]}</span>
                    </button>
                  ))}
                </div>
                <Boton
                  variante="oscuro"
                  icono="flecha"
                  onClick={invitar}
                  deshabilitado={!correo.trim()}
                >
                  Enviar
                </Boton>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Lista de miembros */}
      <div className="mt-8 flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {lista.map((m, i) => (
            <motion.div
              key={m.id}
              layout
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.4, delay: i * 0.04, ease: [0.22, 1, 0.36, 1] }}
            >
              <Tarjeta className="flex items-center gap-4 p-4">
                <Avatar nombre={m.nombre} indice={i} tamano="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-bold">{m.nombre}</span>
                    {m.esTu && (
                      <span className="rounded-full border border-linea bg-papel px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-sepia">
                        Tú
                      </span>
                    )}
                  </div>
                  {m.correo && (
                    <span className="truncate text-sm text-sepia">{m.correo}</span>
                  )}
                </div>

                {/* Rol */}
                <span className="hidden items-center gap-1.5 sm:flex">
                  {m.rol === "admin" ? (
                    <ShieldCheck className="size-4 text-tinta" strokeWidth={2} />
                  ) : (
                    <Shield className="size-4 text-sepia" strokeWidth={2} />
                  )}
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-sepia">
                    {etiquetaRol[m.rol]}
                  </span>
                </span>

                {/* Estado / acción */}
                {m.estado === "pendiente" ? (
                  <span className="rounded-full border border-linea px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-sepia">
                    Invitación enviada
                  </span>
                ) : soyAdmin && !m.esTu ? (
                  <button
                    onClick={() => quitar(m.id)}
                    aria-label={`Quitar a ${m.nombre}`}
                    className="text-sepia transition-colors hover:text-ladrillo"
                  >
                    <X className="size-4" />
                  </button>
                ) : (
                  <span className="w-4" />
                )}
              </Tarjeta>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Nota de roles */}
      <Reveal retraso={0.1}>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <div className="flex items-start gap-3 rounded-2xl border border-linea p-5">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-tinta" strokeWidth={2} />
            <div>
              <p className="font-semibold">Administrador</p>
              <p className="mt-1 text-sm leading-relaxed text-sepia">
                Crea y ajusta automatizaciones, invita al equipo y maneja el
                plan. Ideal para dueños y gerentes.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-2xl border border-linea p-5">
            <Shield className="mt-0.5 size-5 shrink-0 text-sepia" strokeWidth={2} />
            <div>
              <p className="font-semibold">Operador</p>
              <p className="mt-1 text-sm leading-relaxed text-sepia">
                Ejecuta todas las automatizaciones del portafolio y descarga sus
                resultados. No las modifica. Ideal para el equipo del día a día.
              </p>
            </div>
          </div>
        </div>
      </Reveal>

      {elemento}
    </div>
  );
}
