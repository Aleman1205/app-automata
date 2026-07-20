"use client";

import { motion } from "motion/react";
import { Avatar } from "@/components/ui/avatar";
import { equipo, obtenerMiembro, type EjecucionPrevia } from "@/lib/datos";

// Tabla de ejecuciones anteriores. Sigue el estilo de la Tabla del sistema
// (encabezado mono, filas en cascada, hover), pero permite pintar "Falló"
// en ladrillo y mostrar QUIÉN ejecutó con su avatar — cosas que la Tabla base
// no soporta.
const encabezados = [
  { etiqueta: "Fecha", alinear: "text-left" },
  { etiqueta: "Archivo", alinear: "text-left" },
  { etiqueta: "Ejecutó", alinear: "text-left" },
  { etiqueta: "Duración", alinear: "text-right" },
  { etiqueta: "Estado", alinear: "text-right" },
];

export function TablaHistorial({ historial }: { historial: EjecucionPrevia[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-linea">
            {encabezados.map((e) => (
              <th
                key={e.etiqueta}
                className={`py-3 pr-4 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-sepia ${e.alinear}`}
              >
                {e.etiqueta}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {historial.map((ej, i) => {
            const quien = obtenerMiembro(ej.por);
            const indice = equipo.findIndex((m) => m.id === ej.por);
            return (
              <motion.tr
                key={`${ej.fecha}-${i}`}
                className="border-b border-linea/60 transition-colors duration-200 hover:bg-papel"
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-20px" }}
                transition={{
                  duration: 0.4,
                  delay: i * 0.05,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <td className="py-3 pr-4 tabular-nums">{ej.fecha}</td>
                <td className="py-3 pr-4">{ej.archivo}</td>
                <td className="py-3 pr-4">
                  {quien ? (
                    <span className="flex items-center gap-2 whitespace-nowrap">
                      <Avatar
                        nombre={quien.nombre}
                        indice={indice}
                        tamano="sm"
                      />
                      <span>{quien.nombre}</span>
                    </span>
                  ) : (
                    <span className="text-sepia">—</span>
                  )}
                </td>
                <td className="py-3 pr-4 text-right tabular-nums">
                  {ej.duracion}
                </td>
                <td
                  className={`py-3 pr-4 text-right ${
                    ej.estado === "Falló"
                      ? "font-semibold text-ladrillo"
                      : "text-sepia"
                  }`}
                >
                  {ej.estado}
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
