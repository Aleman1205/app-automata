// Los 3 casos de prueba del spike.
//
// Cada caso simula lo que el agente de INTAKE produciría tras entrevistar al
// cliente: un SPEC estructurado. Aquí está escrito a mano — el spike prueba el
// build, no la entrevista.
//
// >>> CAMBIA ESTOS CASOS POR PROCESOS REALES TUYOS <<<
// Pon tu archivo en spike/datos/ y ajusta `objetivo`, `reglas` y
// `criterios_exito`. Los criterios son lo más importante: son lo que el
// Verifier usa para decidir si la automatización sirve.

export const casos = [
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
