"use client";


import { Insignia } from "@/components/ui/insignia";
import { moneda, porcentaje, entero } from "automata-core/vista/formato";

export interface Columna {
  campo: string;
  etiqueta: string;
  alinear?: "izquierda" | "derecha";
  formato?: "moneda" | "entero" | "texto" | "porcentaje" | "estado";
}

// Tabla del sistema: encabezado mono, hover por fila.
//
// Las filas YA NO entran en cascada. Tenían `delay: i * 0.05`, así que una tabla de 500 renglones
// —tamaño normal de una conciliación mensual— tardaba 25 segundos en terminar de aparecer, y
// mientras tanto no se podía leer ni buscar con Cmd+F. Una hoja de cálculo no se anima: aquí el
// dato es el producto, y hacerlo esperar por una entrada bonita es cobrarle al cliente en tiempo
// lo que se le da en estética. El hover se queda (ayuda a seguir el renglón).
export function Tabla({
  columnas,
  filas,
}: {
  columnas: Columna[];
  filas: Record<string, string | number>[];
}) {
  // Los formatos vienen de `core/src/vista/formato.ts` (probados en `verify:formato`), no de una
  // copia local. El de moneda SIEMPRE lleva centavos: estaba redondeando a pesos enteros, y en un
  // producto que existe para cuadrar cuentas eso no es estética, es un dato falso — $43,200.00 en
  // libros contra $43,199.63 en banco se veía como diferencia $0.
  const fmt = (v: string | number, formato?: string) => {
    if (formato === "estado") return <Insignia texto={String(v)} />;
    if (typeof v !== "number") return v;
    if (formato === "moneda") return moneda(v);
    if (formato === "porcentaje") return porcentaje(v);
    return entero(v);
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-linea">
            {columnas.map((c) => (
              <th
                key={c.campo}
                className={`py-3 pr-4 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-sepia ${
                  c.alinear === "derecha" ? "text-right" : "text-left"
                }`}
              >
                {c.etiqueta}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((fila, i) => (
            <tr
              key={i}
              className="border-b border-linea/60 transition-colors duration-200 hover:bg-papel"
            >
              {columnas.map((c) => (
                <td
                  key={c.campo}
                  className={`py-3 pr-4 ${
                    c.alinear === "derecha"
                      ? "text-right tabular-nums"
                      : "text-left"
                  } ${c.formato === "moneda" ? "font-semibold" : ""}`}
                >
                  {fmt(fila[c.campo], c.formato)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
