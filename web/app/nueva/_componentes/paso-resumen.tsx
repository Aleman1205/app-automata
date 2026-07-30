"use client";

import { useRef } from "react";
import { Check, FileCheck2, FileSpreadsheet, Upload } from "lucide-react";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Tarjeta } from "@/components/ui/tarjeta";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { specResumen } from "@/lib/datos";

export interface DatosResumen {
  objetivo: string;
  entradas: string[];
  salidas: string[];
  reglas: string[];
  criterios: string[];
}

// Pantalla de aprobación: lo que la entrevista entendió, en lenguaje llano.
// `datos` viene del intake real; si no, cae al spec de demo.
export function PasoResumen({
  datos = specResumen,
  archivo,
  onArchivo,
  cargando = false,
  error,
  onCorregir,
  onAprobar,
}: {
  datos?: DatosResumen;
  archivo: File | null;
  onArchivo: (f: File) => void;
  cargando?: boolean;
  error?: string | null;
  onCorregir: () => void;
  onAprobar: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <Reveal>
        <Etiqueta punto>REVISA Y APRUEBA</Etiqueta>
      </Reveal>

      <TextoRevelado
        como="h2"
        texto="Esto es lo que vamos a construir."
        className="mt-4 text-3xl font-black tracking-tight md:text-5xl"
        retraso={0.1}
      />

      <div className="mt-10 flex flex-col gap-4">
        <Reveal retraso={0.15}>
          <Tarjeta className="p-6">
            <Etiqueta>OBJETIVO</Etiqueta>
            <p className="mt-3 text-base leading-relaxed text-tinta md:text-lg">
              {datos.objetivo}
            </p>
          </Tarjeta>
        </Reveal>

        <div className="grid gap-4 md:grid-cols-2">
          <Reveal retraso={0.23} className="h-full">
            <Tarjeta className="h-full p-6">
              <Etiqueta>VAS A SUBIR</Etiqueta>
              <ul className="mt-3 flex flex-col gap-2.5">
                {datos.entradas.map((entrada) => (
                  <li key={entrada} className="flex items-start gap-2.5">
                    <FileSpreadsheet
                      className="mt-0.5 size-4 shrink-0 text-sepia"
                      strokeWidth={1.75}
                    />
                    <span className="text-sm leading-relaxed text-tinta">
                      {entrada}
                    </span>
                  </li>
                ))}
              </ul>
            </Tarjeta>
          </Reveal>

          <Reveal retraso={0.31} className="h-full">
            <Tarjeta className="h-full p-6">
              <Etiqueta>VAS A RECIBIR</Etiqueta>
              <ul className="mt-3 flex flex-col gap-2.5">
                {datos.salidas.map((salida) => (
                  <li key={salida} className="flex items-start gap-2.5">
                    <FileCheck2
                      className="mt-0.5 size-4 shrink-0 text-sepia"
                      strokeWidth={1.75}
                    />
                    <span className="text-sm leading-relaxed text-tinta">
                      {salida}
                    </span>
                  </li>
                ))}
              </ul>
            </Tarjeta>
          </Reveal>
        </div>

        <Reveal retraso={0.39}>
          <Tarjeta className="p-6">
            <Etiqueta>REGLAS DE TU NEGOCIO</Etiqueta>
            <ul className="mt-3 flex flex-col gap-2.5">
              {datos.reglas.map((regla) => (
                <li key={regla} className="flex items-start gap-2.5">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-sepia" />
                  <span className="text-sm leading-relaxed text-tinta">
                    {regla}
                  </span>
                </li>
              ))}
            </ul>
          </Tarjeta>
        </Reveal>

        <Reveal retraso={0.47}>
          <div className="rounded-2xl border border-linea bg-papel p-6">
            <Etiqueta>LO DAREMOS POR BUENO CUANDO</Etiqueta>
            <ul className="mt-3 flex flex-col gap-2.5">
              {datos.criterios.map((criterio) => (
                <li key={criterio} className="flex items-start gap-2.5">
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-oliva"
                    strokeWidth={3}
                  />
                  <span className="text-sm leading-relaxed text-tinta">
                    {criterio}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>

      <Reveal retraso={0.55} className="mt-8">
        <Etiqueta>ARCHIVO DE EJEMPLO</Etiqueta>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept=".csv,.xlsx,.xls,.xml,.pdf,.jpg,.jpeg,.png,.zip"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onArchivo(f);
            e.target.value = ""; // permite re-elegir el mismo archivo
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`mt-3 flex w-full items-center gap-4 rounded-2xl bg-hueso p-5 text-left transition hover:border-sepia ${
            archivo ? "border border-linea" : "border-2 border-dashed border-linea"
          }`}
        >
          {archivo ? (
            <>
              <FileSpreadsheet className="size-6 shrink-0 text-sepia" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-tinta">{archivo.name}</p>
                <p className="text-sm text-sepia">Con esto construimos y probamos tu automatización</p>
              </div>
              <Check className="size-5 shrink-0 text-oliva" strokeWidth={3} />
            </>
          ) : (
            <>
              <Upload className="size-6 shrink-0 text-sepia" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-tinta">Sube tu archivo de ejemplo</p>
                <p className="text-sm text-sepia">Lo necesitamos para construir y probar tu automatización</p>
              </div>
            </>
          )}
        </button>
      </Reveal>

      <Reveal retraso={0.6} className="mt-6">
        <Etiqueta>
          PODRÁS PEDIR HASTA 3 AJUSTES CUANDO ESTÉ LISTA · LAS REPARACIONES SON
          GRATIS
        </Etiqueta>
      </Reveal>

      {error && (
        <div className="mt-6 rounded-xl border border-linea bg-papel px-4 py-3 text-sm text-ladrillo">
          {error}
        </div>
      )}

      <Reveal
        retraso={0.63}
        className="mt-8 flex flex-wrap items-center justify-between gap-4"
      >
        <Boton variante="fantasma" onClick={onCorregir}>
          Corregir mis respuestas
        </Boton>
        <Boton
          variante="acento"
          icono="check"
          deshabilitado={cargando || !archivo}
          onClick={onAprobar}
        >
          {cargando ? "Construyendo…" : "Aprobar y construir"}
        </Boton>
      </Reveal>
    </div>
  );
}
