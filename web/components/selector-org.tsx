"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { misOrgs, orgActualVista, elegirOrg, type OrgVista } from "@/lib/automata/lectura";

// Selector de EQUIPO. Antes el front tomaba `orgs[0]` fijo: quien pertenecía a dos equipos veía
// solo el primero y NADA le decía que existía el otro — ni una señal de que le faltaba la mitad
// de su trabajo.
//
// Solo se pinta si hay MÁS DE UNO. Con un solo equipo (el caso normal) un selector es ruido, y
// peor: sugiere que hay algo que elegir. Con cero (sin backend/login) tampoco aparece, así que el
// prototipo con datos falsos se ve igual que antes.
export function SelectorOrg({ variante = "escritorio" }: { variante?: "escritorio" | "movil" }) {
  const [orgs, setOrgs] = useState<OrgVista[]>([]);
  const [actual, setActual] = useState<OrgVista | null>(null);
  const [abierto, setAbierto] = useState(false);
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let vivo = true;
    Promise.all([misOrgs(), orgActualVista()])
      .then(([lista, act]) => { if (vivo) { setOrgs(lista); setActual(act); } })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  // Cerrar al hacer clic fuera o con Escape: es un menú flotante sobre el resto de la app.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => { if (!caja.current?.contains(e.target as Node)) setAbierto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAbierto(false); };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", fuera); document.removeEventListener("keydown", esc); };
  }, [abierto]);

  if (orgs.length < 2 || !actual) return null;

  // En el menú móvil el fondo es oscuro y no hay espacio para un flotante: se listan los equipos
  // planos. Omitirlo dejaría a quien entra desde el teléfono con dos equipos igual de atrapado que
  // antes — que es el bug que esto viene a arreglar.
  if (variante === "movil") {
    return (
      <div className="flex flex-col gap-1 border-t border-crema/15 pt-4">
        <span className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-crema/50">
          Tus equipos
        </span>
        {orgs.map((o) => {
          const esActual = o.id === actual.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => (esActual ? undefined : void elegirOrg(o.id))}
              className={`flex items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition-colors ${esActual ? "text-crema" : "text-crema/70 hover:text-crema"}`}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{o.nombre}</span>
              {esActual && <Check className="size-4 shrink-0" strokeWidth={2.5} />}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={caja} className="relative">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        className="flex max-w-[13rem] items-center gap-1.5 rounded-full border border-linea bg-papel px-3.5 py-2 text-sm font-semibold transition-colors duration-200 hover:border-tinta"
      >
        <span className="truncate">{actual.nombre}</span>
        <ChevronDown className={`size-4 shrink-0 text-sepia transition-transform duration-200 ${abierto ? "rotate-180" : ""}`} strokeWidth={2.5} />
      </button>

      {abierto && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-50 mt-2 min-w-[15rem] overflow-hidden rounded-2xl border border-linea bg-papel p-1.5 shadow-xl shadow-noche/10"
        >
          {orgs.map((o) => {
            const esActual = o.id === actual.id;
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={esActual}
                // Cambiar a la que ya se ve recargaría la página para nada.
                onClick={() => (esActual ? setAbierto(false) : void elegirOrg(o.id))}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition-colors duration-150 ${esActual ? "bg-lino" : "hover:bg-lino"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{o.nombre}</span>
                  {/* El ROL importa aquí: en un equipo puedes ser admin y en otro solo operador, y
                      eso cambia lo que la pantalla te va a dejar hacer. */}
                  <span className="block text-xs text-sepia">
                    {o.rol === "admin" ? "Administrador" : "Operador"}
                  </span>
                </span>
                {esActual && <Check className="size-4 shrink-0 text-tinta" strokeWidth={2.5} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
