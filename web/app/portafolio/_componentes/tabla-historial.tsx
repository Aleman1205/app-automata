"use client";

import { Avatar } from "@/components/ui/avatar";
import { equipo, obtenerMiembro, type EjecucionPrevia } from "@/lib/datos";

// Tabla de ejecuciones anteriores. Sigue el estilo de la Tabla del sistema (encabezado mono,
// hover), pero permite pintar "Falló" en ladrillo y mostrar QUIÉN ejecutó con su avatar — cosas
// que la Tabla base no soporta.
//
// Las filas ya se pueden ABRIR. Antes esta tabla listaba fecha, duración y estado, y ahí moría:
// el resultado estaba guardado y la API lo devolvía, pero no había dónde hacer clic. En la
// práctica el cliente veía su reporte UNA vez y, para volver a verlo, tenía que ejecutar otra vez
// — gastando una ejecución de su cuota por consultar algo que ya había pagado.
//
// Sin cascada por fila, por lo mismo que la Tabla del sistema: es una lista de datos, no una
// entrada de escena.
const encabezados = [
  { etiqueta: "Fecha", alinear: "text-left" },
  { etiqueta: "Archivo", alinear: "text-left" },
  { etiqueta: "Ejecutó", alinear: "text-left" },
  { etiqueta: "Duración", alinear: "text-right" },
  { etiqueta: "Estado", alinear: "text-right" },
  { etiqueta: "", alinear: "text-right" },
];

export function TablaHistorial({
  historial,
  onAbrir,
  abriendo,
}: {
  historial: EjecucionPrevia[];
  /** Ausente en el prototipo demo (sus datos falsos no tienen id que abrir). */
  onAbrir?: (id: string) => void;
  abriendo?: string | null;
}) {
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
              <tr
                key={`${ej.fecha}-${i}`}
                className="border-b border-linea/60 transition-colors duration-200 hover:bg-papel"
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
                <td className="py-3 text-right">
                  {onAbrir && ej.id && ej.tieneResultado ? (
                    <button
                      type="button"
                      onClick={() => onAbrir(ej.id!)}
                      disabled={abriendo === ej.id}
                      className="rounded-full border border-linea px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-sepia transition-colors hover:bg-crema hover:text-tinta disabled:opacity-50"
                    >
                      {abriendo === ej.id ? "Abriendo…" : "Ver"}
                    </button>
                  ) : (
                    // Una corrida que falló no dejó resultado. Un botón muerto haría creer que
                    // se perdió algo; el guion dice que no hubo nada que guardar.
                    <span className="font-mono text-[10px] text-sepia/60">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
