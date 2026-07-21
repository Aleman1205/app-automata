import type { Spec } from "../types.ts";

// Spec del caso (en M1 lo produce el intake; aquí va a mano, como spike/casos.js).
export const dashboardPopularidadSpec: Spec = {
  objetivo:
    "A partir del reporte de popularidad de productos (hoja de Excel del sistema " +
    "del restaurante), producir los DATOS de un dashboard: métricas clave, un " +
    "desglose por familia, y el top de productos.",
  reglas: [
    "Usa SOLO el detalle de producto (una fila por producto vendido). Excluye la " +
      "fila 'Total', la segunda tabla 'Totales por familia' y encabezados repetidos.",
    "Agrupa por la familia del producto para el desglose.",
    "El margen es utilidad ÷ ingreso, en porcentaje.",
    "Los montos son pesos mexicanos; consérvalos como números, con dos decimales.",
  ],
  criterios_exito: [
    "El resultado JSON tiene métricas (objeto), familias (arreglo) y top_productos (arreglo).",
    "El número de productos contados es 448 (± 2).",
    "El ingreso total es 53,239,430.50 (± 0.5 %).",
    "La utilidad total es 26,100,916.43 (± 0.5 %) y el margen redondea a 49.0 %.",
    "Hay 44 familias (± 2) y la suma del ingreso por familia iguala el ingreso total.",
  ],
  entradas: [
    { tipo: "archivo", formato: "xlsx", descripcion: "Reporte de popularidad de productos." },
  ],
};
