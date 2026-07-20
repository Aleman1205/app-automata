// Los casos de prueba del spike.
//
// Cada caso simula lo que el agente de INTAKE produciría tras entrevistar al
// cliente: un SPEC estructurado. Aquí está escrito a mano — el spike prueba el
// build, no la entrevista.
//
// CASO REAL ACTIVO: "Vitrales" — reporte de popularidad de productos de un
// restaurante (archivo real del usuario). Los sintéticos quedan abajo,
// comentados, por si se quieren correr después.

export const casos = [
  {
    id: "dashboard-popularidad",
    nombre: "Dashboard de popularidad de productos",
    archivo: "gastos.xlsx", // el .xlsx real de Vitrales
    spec: {
      objetivo:
        "A partir del reporte de popularidad de productos (una hoja de Excel " +
        "exportada del sistema del restaurante), producir los DATOS de un " +
        "dashboard para verlos en pantalla: métricas clave del negocio, un " +
        "desglose por familia de producto, y el top de productos. La persona " +
        "que hoy arma ese dashboard a mano debería poder dejar de hacerlo.",
      entradas: [
        {
          tipo: "archivo",
          formato: "xlsx",
          descripcion:
            "Reporte de popularidad: una fila por producto con cantidad " +
            "vendida, ingreso, costo, utilidad y su familia. OJO: el archivo " +
            "trae basura de sistema — dos tablas apiladas en la misma hoja, " +
            "filas de subtotal/total, encabezados repetidos y columnas " +
            "corridas en las filas de resumen.",
        },
      ],
      salidas: [
        {
          tipo: "datos",
          formato: "json",
          descripcion:
            "Un resultado.json con la estructura del dashboard: un bloque de " +
            "métricas, un arreglo de familias con sus totales, y un arreglo " +
            "con el top de productos. Además, un dashboard.xlsx de respaldo.",
        },
      ],
      reglas: [
        "Usa SOLO el detalle de producto (una fila por producto vendido). " +
          "Excluye la fila 'Total', la segunda tabla de 'Totales por familia' " +
          "y cualquier fila de subtotal o encabezado repetido.",
        "Agrupa por la familia del producto para el desglose.",
        "El margen es utilidad ÷ ingreso, en porcentaje.",
        "Los montos son pesos mexicanos; consérvalos como números, sin el " +
          "símbolo, con dos decimales.",
      ],
      criterios_exito: [
        "El resultado.json es válido y tiene tres secciones: métricas (objeto), " +
          "familias (arreglo) y top_productos (arreglo).",
        "El número de productos contados es 448 (± 2). Si sale ~492 o más, el " +
          "código contó también las filas de la tabla de resumen (que traen el " +
          "producto vacío) y está mal.",
        "El ingreso total es 53,239,430.50 (± 0.5 %). Si sale cerca de " +
          "106,000,000 o más, contó de más por no excluir la segunda tabla o la " +
          "fila Total.",
        "La utilidad total es 26,100,916.43 (± 0.5 %) y el margen redondea a 49.0 %.",
        "Hay 44 familias (± 2), y la suma del ingreso de todas las familias es " +
          "igual al ingreso total (± 0.5 %) — consistencia interna.",
        "El top de productos por ingreso encabeza con TACO DE FILETE (1 PZ) " +
          "(~425,783) y JUGO DE TOMATE (~410,761).",
      ],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// CASOS SINTÉTICOS (desactivados). Para usarlos: genera sus datos con
// `npm run datos`, y muévelos arriba al array `casos`.
// ─────────────────────────────────────────────────────────────────────────────
export const casosSinteticos = [
  {
    id: "ventas-mensual",
    nombre: "Resumen mensual de ventas por vendedor",
    archivo: "ventas.csv",
    spec: {
      objetivo:
        "A partir del archivo de ventas, generar una hoja de cálculo con el " +
        "total vendido por cada vendedor en cada mes.",
      entradas: [
        { tipo: "archivo", formato: "csv", descripcion: "Ventas con fecha, vendedor, monto y estado" },
      ],
      salidas: [{ tipo: "archivo", formato: "xlsx" }],
      reglas: [
        "Ignorar las ventas con estado 'cancelada'.",
        "Los meses van en orden cronológico.",
      ],
      criterios_exito: [
        "El archivo de salida es un .xlsx válido que se puede abrir.",
        "Hay exactamente una fila por vendedor.",
        "Hay una columna por cada mes presente en los datos de entrada.",
        "Ninguna venta cancelada está incluida en los totales.",
        "La suma de todos los totales es igual a la suma de los montos no cancelados del archivo de entrada.",
      ],
    },
  },
  {
    id: "facturas-consolidado",
    nombre: "Consolidado de facturas por proveedor",
    archivo: "facturas.csv",
    spec: {
      objetivo:
        "Consolidar las facturas en un reporte con el total facturado por " +
        "proveedor y el número de facturas de cada uno.",
      entradas: [
        { tipo: "archivo", formato: "csv", descripcion: "Facturas con proveedor, RFC, monto, IVA y estado" },
      ],
      salidas: [{ tipo: "archivo", formato: "xlsx" }],
      reglas: [
        "Agrupar por RFC, no por nombre de proveedor (el nombre puede venir escrito distinto).",
        "El total debe incluir el IVA.",
        "Excluir facturas canceladas.",
      ],
      criterios_exito: [
        "El archivo de salida es un .xlsx válido.",
        "Hay una fila por RFC único.",
        "Cada fila tiene: RFC, nombre de proveedor, número de facturas, total con IVA.",
        "El gran total coincide con la suma de (monto + IVA) de las facturas no canceladas.",
        "Dos filas con el mismo RFC y distinto nombre quedaron agrupadas en una sola.",
      ],
    },
  },
  {
    id: "limpieza-contactos",
    nombre: "Limpieza y deduplicado de lista de contactos",
    archivo: "contactos.csv",
    spec: {
      objetivo:
        "Limpiar una lista de contactos: quitar duplicados, normalizar el " +
        "formato y separar los registros con datos inválidos.",
      entradas: [
        { tipo: "archivo", formato: "csv", descripcion: "Contactos con nombre, email y teléfono" },
      ],
      salidas: [
        { tipo: "archivo", formato: "xlsx", descripcion: "Dos hojas: 'limpios' y 'revisar'" },
      ],
      reglas: [
        "Un contacto es duplicado si tiene el mismo email, sin importar mayúsculas o espacios.",
        "Los emails van en minúsculas y sin espacios sobrantes.",
        "Los contactos con email inválido van a la hoja 'revisar', no se descartan.",
      ],
      criterios_exito: [
        "El archivo de salida es un .xlsx con exactamente dos hojas: 'limpios' y 'revisar'.",
        "En la hoja 'limpios' no hay dos filas con el mismo email.",
        "Todos los emails de 'limpios' están en minúsculas y sin espacios al inicio o final.",
        "Todo contacto con email inválido aparece en 'revisar'.",
        "La suma de filas de ambas hojas más los duplicados eliminados es igual al total de filas de entrada.",
      ],
    },
  },
];
