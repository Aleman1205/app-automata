// ─────────────────────────────────────────────────────────────────────────────
// Cómo se LEE un resultado: el vocabulario del semáforo y los formatos de número.
//
// Vive en `core` y no en el front porque no es React: es parte del contrato. Decidir si
// "conciliado" se ve verde o gris, o si un importe muestra centavos, cambia lo que el cliente
// ENTIENDE de su reporte — y eso merece un test, no quedar suelto en un componente donde nadie
// lo vigila. Antes estaba en `web/components/ui/insignia.tsx` con dos regex y sin una sola prueba.
// ─────────────────────────────────────────────────────────────────────────────

export type TonoEstado = "ok" | "revisar" | "alerta" | "neutro";

// El orden IMPORTA: se toma la primera familia que case, y `alerta` va antes que `ok` porque
// "sin conciliar" contiene "concili". Invertirlo pintaría de verde un descuadre.
const VOCABULARIO: [TonoEstado, RegExp][] = [
  // Rojo: no cuadra, falta el dato, o se rechazó. Exige acción.
  ["alerta", /no cuadra|descuadr|sin concili|no concili|rechaz|error|inválid|invalid|falta|sin dato|ilegible|duplicad|vencid|agot|sin fondos/i],
  // Ámbar: cuadra con reserva, o está en curso. Exige mirada, no acción inmediata. Es el estado
  // que NO existía: antes todo esto caía en gris, y en un reporte contable el caso intermedio
  // ("con tolerancia", "en tránsito", "pendiente de cobro") es la mitad del trabajo.
  ["revisar", /revisar|toleranci|tránsito|transito|pendient|parcial|aproximad|estimad|baja confianza|ocr|excepci/i],
  // Verde: cerrado y correcto.
  ["ok", /concili|exact|correct|al día|al dia|\bok\b|listo|pagad|complet|sano|cotej|aplicad/i],
];

/**
 * Tono de una celda con `formato: "estado"`. Desconocido → `neutro`.
 * Gris significa "no lo reconocimos", y decirlo es más honesto que pintar de verde algo que no
 * entendimos: el cliente cerraría el reporte creyendo que todo cuadró.
 */
export function tonoDeEstado(texto: string): TonoEstado {
  for (const [tono, re] of VOCABULARIO) if (re.test(texto)) return tono;
  return "neutro";
}

/**
 * Dinero, SIEMPRE con centavos. Es el único formato que corrige un dato falso y no una
 * apariencia: con `maximumFractionDigits: 0`, una conciliación de $43,200.00 en libros contra
 * $43,199.63 en banco se veía como $43,200 contra $43,200 y diferencia $0 — el reporte afirmaba
 * que cuadraba cuando no cuadraba. El descuadre típico (comisiones, redondeos, tipo de cambio)
 * vive justo en los centavos.
 */
export function moneda(v: number): string {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

/** Porcentaje con un decimal: "98.4%". */
export function porcentaje(v: number): string {
  return `${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 }).format(v)}%`;
}

/** Conteos y unidades: separador de miles, sin decimales. */
export function entero(v: number): string {
  return new Intl.NumberFormat("es-MX").format(v);
}
