// ─────────────────────────────────────────────────────────────────────────────
// Datos falsos del prototipo. Nada llama a un backend: todo lo que se ve en la
// app sale de este archivo.
// ─────────────────────────────────────────────────────────────────────────────

export type EstadoAuto = "lista" | "generando" | "fallo" | "congelada";

export interface EntradaManifiesto {
  id: string;
  tipo: "archivo" | "seleccion";
  etiqueta: string;
  ayuda?: string;
  formatos?: string[]; // p. ej. ["xlsx","csv"] o ["jpg","png","pdf"] — NO solo Excel
  multiple?: boolean; // varios archivos a la vez (p. ej. fotos de tickets)
  ejemploNombre?: string; // nombre falso que se muestra "cargado" en la demo
  opciones?: { valor: string; etiqueta: string }[];
}

export interface MetricaDemo {
  etiqueta: string;
  valor: number;
  formato: "moneda" | "entero";
  sufijo?: string; // p. ej. "%" para márgenes o rotación
  nota?: string;
  tendencia?: string; // p. ej. "+12% vs. mes pasado"
}

export interface PuntoDato {
  etiqueta: string;
  valor: number;
}

export interface ColumnaDemo {
  campo: string;
  etiqueta: string;
  alinear?: "izquierda" | "derecha";
  formato?: "moneda" | "entero" | "texto" | "porcentaje" | "estado";
}

export type FilaDemo = Record<string, string | number>;

// Un resultado ya no es "3 cajones fijos": es una lista ordenada de BLOQUES que
// el agente compone según el proceso. Los mismos bloques cubren ventas, RH,
// administrativo, limpieza… sin una pantalla por dominio (ver docs/09).
export type Bloque =
  | { tipo: "resumen"; texto: string }
  | { tipo: "metricas"; items: MetricaDemo[] }
  | { tipo: "callout"; tono: "info" | "ok" | "alerta"; titulo: string; texto?: string }
  | { tipo: "barras"; titulo: string; formato: "moneda" | "entero"; datos: PuntoDato[] }
  | { tipo: "linea"; titulo: string; formato: "moneda" | "entero"; datos: PuntoDato[] }
  | { tipo: "ranking"; titulo: string; formato: "moneda" | "entero"; datos: PuntoDato[] }
  | { tipo: "tabla"; titulo?: string; columnas: ColumnaDemo[]; filas: FilaDemo[] }
  | {
      tipo: "comparacion";
      titulo: string;
      pasos: { etiqueta: string; valor: number; tono?: "ok" | "alerta" | "neutro" }[];
    };

export interface ResultadoDemo {
  bloques: Bloque[];
  archivoSalida: string;
}

export interface EjecucionPrevia {
  fecha: string;
  archivo: string;
  duracion: string;
  estado: "Correcta" | "Falló";
  por: string; // id del miembro que la ejecutó
}

export interface CambioVersion {
  version: number;
  titulo: string;
  fecha: string;
  tipo: "construccion" | "ajuste";
}

export interface Automatizacion {
  id: string;
  nombre: string;
  descripcion: string;
  estado: EstadoAuto;
  creada: string;
  ejecuciones: number;
  ultimaEjecucion?: string;
  ajustesUsados: number; // de 3
  motivoFallo?: string;
  entradas: EntradaManifiesto[];
  resultado?: ResultadoDemo;
  historial: EjecucionPrevia[];
  cambios: CambioVersion[];
}

// ── Automatizaciones del portafolio ─────────────────────────────────────────

export const automatizaciones: Automatizacion[] = [
  {
    id: "reporte-ventas",
    nombre: "Reporte mensual de ventas",
    descripcion:
      "Convierte tu archivo de ventas en un reporte por vendedor: totales, promedio y gráfica, sin contar las canceladas.",
    estado: "lista",
    creada: "12 feb 2026",
    ejecuciones: 24,
    ultimaEjecucion: "hace 2 días",
    ajustesUsados: 1,
    entradas: [
      {
        id: "ventas",
        tipo: "archivo",
        etiqueta: "Tu archivo de ventas",
        ayuda: "El export mensual de tu sistema, en Excel o CSV",
        formatos: ["csv", "xlsx"],
      },
      {
        id: "mes",
        tipo: "seleccion",
        etiqueta: "¿Qué mes quieres reportar?",
        opciones: [
          { valor: "todos", etiqueta: "Todos los meses del archivo" },
          { valor: "ultimo", etiqueta: "Solo el mes más reciente" },
        ],
      },
    ],
    resultado: {
      bloques: [
        {
          tipo: "resumen",
          texto:
            "En marzo vendiste $438,250 (subtotal) en 214 ventas: 12% más que el mes pasado y 104% de tu meta de $420,000. Ana Ruiz volvió a encabezar y el ticket promedio subió a $2,048. Las 12 canceladas ya quedaron fuera.",
        },
        {
          tipo: "metricas",
          items: [
            {
              etiqueta: "Total vendido",
              valor: 438250,
              formato: "moneda",
              tendencia: "+12% vs. mes pasado",
              nota: "12 canceladas excluidas",
            },
            { etiqueta: "Ventas procesadas", valor: 214, formato: "entero" },
            {
              etiqueta: "Cumplimiento de meta",
              valor: 104,
              formato: "entero",
              sufijo: "%",
              tendencia: "+4% sobre la meta",
              nota: "Meta: $420,000",
            },
            {
              etiqueta: "Ticket promedio",
              valor: 2048,
              formato: "moneda",
              tendencia: "+4% vs. mes pasado",
            },
          ],
        },
        {
          tipo: "linea",
          titulo: "Total vendido por mes",
          formato: "moneda",
          datos: [
            { etiqueta: "Oct", valor: 312400 },
            { etiqueta: "Nov", valor: 358900 },
            { etiqueta: "Dic", valor: 405200 },
            { etiqueta: "Ene", valor: 372600 },
            { etiqueta: "Feb", valor: 391300 },
            { etiqueta: "Mar", valor: 438250 },
          ],
        },
        {
          tipo: "ranking",
          titulo: "Vendedores por total",
          formato: "moneda",
          datos: [
            { etiqueta: "Ana Ruiz", valor: 128450 },
            { etiqueta: "Luis Mora", valor: 117300 },
            { etiqueta: "Carmen Díaz", valor: 104980 },
            { etiqueta: "Jorge Peña", valor: 87520 },
          ],
        },
        {
          tipo: "tabla",
          titulo: "Detalle por vendedor",
          columnas: [
            { campo: "vendedor", etiqueta: "Vendedor" },
            { campo: "ventas", etiqueta: "Ventas", alinear: "derecha", formato: "entero" },
            { campo: "total", etiqueta: "Total", alinear: "derecha", formato: "moneda" },
            { campo: "promedio", etiqueta: "Promedio", alinear: "derecha", formato: "moneda" },
          ],
          filas: [
            { vendedor: "Ana Ruiz", ventas: 58, total: 128450, promedio: 2215 },
            { vendedor: "Luis Mora", ventas: 55, total: 117300, promedio: 2133 },
            { vendedor: "Carmen Díaz", ventas: 52, total: 104980, promedio: 2019 },
            { vendedor: "Jorge Peña", ventas: 49, total: 87520, promedio: 1786 },
          ],
        },
      ],
      archivoSalida: "reporte-ventas-marzo.xlsx",
    },
    historial: [
      { fecha: "17 mar 2026", archivo: "ventas-marzo.xlsx", duracion: "22 s", estado: "Correcta", por: "luis" },
      { fecha: "12 mar 2026", archivo: "ventas-feb-corregido.xlsx", duracion: "19 s", estado: "Correcta", por: "carmen" },
      { fecha: "10 mar 2026", archivo: "ventas-febrero.xlsx", duracion: "21 s", estado: "Correcta", por: "luis" },
      { fecha: "3 mar 2026", archivo: "ventas-febrero.xlsx", duracion: "8 s", estado: "Falló", por: "luis" },
      { fecha: "17 feb 2026", archivo: "ventas-enero.xlsx", duracion: "24 s", estado: "Correcta", por: "ana" },
    ],
    cambios: [
      { version: 1, titulo: "Construcción original", fecha: "12 feb 2026", tipo: "construccion" },
      {
        version: 2,
        titulo: "Agregar el ticket promedio por vendedor",
        fecha: "15 feb 2026",
        tipo: "ajuste",
      },
    ],
  },
  {
    id: "consolidado-facturas",
    nombre: "Consolidado de facturas por proveedor",
    descripcion:
      "Agrupa tus facturas por RFC —aunque el nombre venga escrito distinto—, suma el IVA y excluye las canceladas.",
    estado: "lista",
    creada: "28 feb 2026",
    ejecuciones: 11,
    ultimaEjecucion: "hace 5 días",
    ajustesUsados: 0,
    entradas: [
      {
        id: "facturas",
        tipo: "archivo",
        etiqueta: "Tus facturas del periodo",
        ayuda: "Un CSV o Excel con folio, proveedor, RFC, monto e IVA",
        formatos: ["csv", "xlsx"],
      },
      {
        id: "periodo",
        tipo: "seleccion",
        etiqueta: "¿Qué periodo cubre?",
        opciones: [
          { valor: "mes", etiqueta: "Un mes" },
          { valor: "trimestre", etiqueta: "Un trimestre" },
        ],
      },
    ],
    resultado: {
      bloques: [
        {
          tipo: "resumen",
          texto:
            "Consolidamos 186 facturas en 5 proveedores por $1,284,600 con IVA. Distribuidora del Norte concentra un tercio del gasto. Agrupamos por RFC, así que los proveedores con el nombre escrito distinto quedaron en una sola fila.",
        },
        {
          tipo: "metricas",
          items: [
            {
              etiqueta: "Total facturado",
              valor: 1284600,
              formato: "moneda",
              nota: "Con IVA incluido",
            },
            { etiqueta: "Facturas procesadas", valor: 186, formato: "entero" },
            { etiqueta: "Proveedores", valor: 5, formato: "entero" },
            { etiqueta: "Canceladas excluidas", valor: 9, formato: "entero" },
          ],
        },
        {
          tipo: "callout",
          tono: "info",
          titulo: "3 facturas venían con el proveedor escrito de dos formas",
          texto:
            "Las agrupamos por RFC, no por nombre, así que quedaron consolidadas correctamente. También excluimos 9 canceladas del total.",
        },
        {
          tipo: "barras",
          titulo: "Total por proveedor",
          formato: "moneda",
          datos: [
            { etiqueta: "Dist. Norte", valor: 412800 },
            { etiqueta: "Papelera C.", valor: 296400 },
            { etiqueta: "Servicios GZ", valor: 214350 },
            { etiqueta: "Emp. Rivera", valor: 186700 },
            { etiqueta: "Grupo Lara", valor: 174350 },
          ],
        },
        {
          tipo: "tabla",
          titulo: "Detalle por proveedor",
          columnas: [
            { campo: "proveedor", etiqueta: "Proveedor" },
            { campo: "rfc", etiqueta: "RFC" },
            { campo: "facturas", etiqueta: "Facturas", alinear: "derecha", formato: "entero" },
            { campo: "total", etiqueta: "Total con IVA", alinear: "derecha", formato: "moneda" },
          ],
          filas: [
            { proveedor: "Distribuidora del Norte", rfc: "DNO950101AB1", facturas: 52, total: 412800 },
            { proveedor: "Papelera Central", rfc: "PCE010203XY2", facturas: 41, total: 296400 },
            { proveedor: "Servicios Integrales GZ", rfc: "SIG880404ZZ9", facturas: 38, total: 214350 },
            { proveedor: "Empaques Rivera", rfc: "ERI920707QW3", facturas: 30, total: 186700 },
            { proveedor: "Grupo Lara", rfc: "GLA850505MN8", facturas: 25, total: 174350 },
          ],
        },
      ],
      archivoSalida: "consolidado-proveedores.xlsx",
    },
    historial: [
      { fecha: "14 mar 2026", archivo: "facturas-marzo.csv", duracion: "31 s", estado: "Correcta", por: "carmen" },
      { fecha: "1 mar 2026", archivo: "facturas-febrero.csv", duracion: "28 s", estado: "Correcta", por: "carmen" },
      { fecha: "28 feb 2026", archivo: "facturas-ejemplo.csv", duracion: "26 s", estado: "Correcta", por: "ana" },
    ],
    cambios: [
      { version: 1, titulo: "Construcción original", fecha: "28 feb 2026", tipo: "construccion" },
    ],
  },
  {
    id: "nomina-quincenal",
    nombre: "Resumen de nómina quincenal",
    descripcion:
      "Toma tu archivo de asistencias y sueldos y arma el resumen de la quincena: neto a pagar por persona, por área, y quién trae algo raro.",
    estado: "lista",
    creada: "5 mar 2026",
    ejecuciones: 6,
    ultimaEjecucion: "hace 1 día",
    ajustesUsados: 1,
    entradas: [
      {
        id: "asistencias",
        tipo: "archivo",
        etiqueta: "Tu archivo de asistencias y sueldos",
        ayuda: "El export de tu reloj checador o tu hoja de cálculo",
        formatos: ["csv", "xlsx"],
      },
      {
        id: "quincena",
        tipo: "seleccion",
        etiqueta: "¿Qué quincena?",
        opciones: [
          { valor: "actual", etiqueta: "La quincena en curso" },
          { valor: "anterior", etiqueta: "La quincena pasada" },
        ],
      },
    ],
    resultado: {
      bloques: [
        {
          tipo: "resumen",
          texto:
            "Esta quincena la nómina neta suma $284,600 para 32 personas. Cocina y Recepción concentran la mayor parte. Hay 3 casos que conviene revisar antes de pagar.",
        },
        {
          tipo: "metricas",
          items: [
            { etiqueta: "Nómina neta", valor: 284600, formato: "moneda", nota: "Después de deducciones" },
            { etiqueta: "Personas", valor: 32, formato: "entero" },
            { etiqueta: "Horas extra", valor: 148, formato: "entero", nota: "En toda la quincena" },
            { etiqueta: "Rotación", valor: 6, formato: "entero", sufijo: "%", tendencia: "-2% vs. quincena pasada" },
          ],
        },
        {
          tipo: "callout",
          tono: "alerta",
          titulo: "3 personas necesitan revisión antes de pagar",
          texto:
            "Dos sin RFC registrado y una con más horas extra que su jornada. Las separamos para que las revises.",
        },
        {
          tipo: "barras",
          titulo: "Nómina neta por área",
          formato: "moneda",
          datos: [
            { etiqueta: "Cocina", valor: 92400 },
            { etiqueta: "Recepción", valor: 68200 },
            { etiqueta: "Limpieza", valor: 54800 },
            { etiqueta: "Mantto.", valor: 38600 },
            { etiqueta: "Admin", valor: 30600 },
          ],
        },
        {
          tipo: "tabla",
          titulo: "Detalle por persona",
          columnas: [
            { campo: "empleado", etiqueta: "Empleado" },
            { campo: "area", etiqueta: "Área" },
            { campo: "extra", etiqueta: "Horas extra", alinear: "derecha", formato: "entero" },
            { campo: "neto", etiqueta: "Neto", alinear: "derecha", formato: "moneda" },
            { campo: "estatus", etiqueta: "Estatus", formato: "estado" },
          ],
          filas: [
            { empleado: "María Fuentes", area: "Cocina", extra: 12, neto: 11250, estatus: "Al día" },
            { empleado: "Jorge Lomelí", area: "Recepción", extra: 8, neto: 9800, estatus: "Al día" },
            { empleado: "Sofía Ramos", area: "Limpieza", extra: 6, neto: 7600, estatus: "Al día" },
            { empleado: "Diego Nava", area: "Mantto.", extra: 22, neto: 10400, estatus: "Revisar" },
            { empleado: "Paola Cruz", area: "Cocina", extra: 0, neto: 8900, estatus: "Sin RFC" },
          ],
        },
      ],
      archivoSalida: "nomina-quincena.xlsx",
    },
    historial: [
      { fecha: "16 mar 2026", archivo: "asistencias-q1-marzo.xlsx", duracion: "29 s", estado: "Correcta", por: "ana" },
      { fecha: "1 mar 2026", archivo: "asistencias-q2-feb.xlsx", duracion: "27 s", estado: "Correcta", por: "ana" },
    ],
    cambios: [
      { version: 1, titulo: "Construcción original", fecha: "5 mar 2026", tipo: "construccion" },
      { version: 2, titulo: "Separar a quien le falta RFC en su propia lista", fecha: "9 mar 2026", tipo: "ajuste" },
    ],
  },
  {
    id: "depuracion-clientes",
    nombre: "Depuración de la base de clientes",
    descripcion:
      "Junta tus listas de clientes, quita duplicados, corrige formatos y aparta los registros con datos inválidos para que los revises.",
    estado: "lista",
    creada: "3 mar 2026",
    ejecuciones: 4,
    ultimaEjecucion: "hace 6 días",
    ajustesUsados: 0,
    entradas: [
      {
        id: "clientes",
        tipo: "archivo",
        etiqueta: "Tu lista de clientes",
        ayuda: "Una o varias listas exportadas de tu sistema o tu correo",
        formatos: ["csv", "xlsx"],
      },
    ],
    resultado: {
      bloques: [
        {
          tipo: "resumen",
          texto:
            "De 1,240 registros quedaron 1,180 limpios y sin duplicados. Apartamos 60 con correo o teléfono inválido para que los revises — no los borramos.",
        },
        {
          tipo: "comparacion",
          titulo: "Qué pasó con tus registros",
          pasos: [
            { etiqueta: "Recibidos", valor: 1240, tono: "neutro" },
            { etiqueta: "Limpios", valor: 1180, tono: "ok" },
            { etiqueta: "A revisar", valor: 60, tono: "alerta" },
          ],
        },
        {
          tipo: "metricas",
          items: [
            { etiqueta: "Duplicados unidos", valor: 47, formato: "entero" },
            { etiqueta: "Correos corregidos", valor: 112, formato: "entero", nota: "Mayúsculas y espacios" },
            { etiqueta: "Teléfonos con formato", valor: 389, formato: "entero" },
            { etiqueta: "A revisar", valor: 60, formato: "entero", nota: "Datos inválidos" },
          ],
        },
        {
          tipo: "callout",
          tono: "info",
          titulo: "Nada se borró",
          texto:
            'Los 60 registros con datos inválidos están en la hoja "A revisar" del archivo, listos para que decidas qué hacer con ellos.',
        },
        {
          tipo: "tabla",
          titulo: "Muestra de los que hay que revisar",
          columnas: [
            { campo: "nombre", etiqueta: "Nombre" },
            { campo: "correo", etiqueta: "Correo" },
            { campo: "motivo", etiqueta: "Motivo", formato: "estado" },
          ],
          filas: [
            { nombre: "Comercial Vega", correo: "ventas@vega", motivo: "Correo inválido" },
            { nombre: "(sin nombre)", correo: "j.perez@mail.com", motivo: "Falta nombre" },
            { nombre: "Abarrotes El Sol", correo: "—", motivo: "Sin correo" },
            { nombre: "Tienda Lupita", correo: "lupita@@gmail.com", motivo: "Correo inválido" },
          ],
        },
      ],
      archivoSalida: "clientes-depurados.xlsx",
    },
    historial: [
      { fecha: "14 mar 2026", archivo: "clientes-crm+correo.xlsx", duracion: "33 s", estado: "Correcta", por: "carmen" },
      { fecha: "3 mar 2026", archivo: "clientes-export.csv", duracion: "30 s", estado: "Correcta", por: "ana" },
    ],
    cambios: [
      { version: 1, titulo: "Construcción original", fecha: "3 mar 2026", tipo: "construccion" },
    ],
  },
  {
    id: "gastos-tickets",
    nombre: "Gastos desde fotos de tickets",
    descripcion:
      "Sube las fotos de tus tickets y notas de gasto; te las convierte en una tabla de gastos ordenada, sin capturar nada a mano.",
    estado: "lista",
    creada: "10 mar 2026",
    ejecuciones: 9,
    ultimaEjecucion: "hace 1 día",
    ajustesUsados: 1,
    entradas: [
      {
        id: "tickets",
        tipo: "archivo",
        etiqueta: "Las fotos de tus tickets",
        ayuda: "Súbelas todas juntas — fotos del celular o PDF escaneados",
        formatos: ["jpg", "png", "pdf"],
        multiple: true,
        ejemploNombre: "14 fotos de tickets",
      },
      {
        id: "periodo",
        tipo: "seleccion",
        etiqueta: "¿De qué periodo son?",
        opciones: [
          { valor: "mes", etiqueta: "Este mes" },
          { valor: "quincena", etiqueta: "Esta quincena" },
        ],
      },
    ],
    resultado: {
      bloques: [
        {
          tipo: "resumen",
          texto:
            "Leímos 14 tickets por $18,940 en gastos. La mayor parte se fue en insumos de cocina. 2 fotos salieron borrosas y las apartamos para que las revises.",
        },
        {
          tipo: "comparacion",
          titulo: "Qué pasó con tus fotos",
          pasos: [
            { etiqueta: "Fotos subidas", valor: 16, tono: "neutro" },
            { etiqueta: "Tickets leídos", valor: 14, tono: "ok" },
            { etiqueta: "A revisar", valor: 2, tono: "alerta" },
          ],
        },
        {
          tipo: "metricas",
          items: [
            { etiqueta: "Total en gastos", valor: 18940, formato: "moneda" },
            { etiqueta: "Tickets leídos", valor: 14, formato: "entero" },
            { etiqueta: "Categorías", valor: 5, formato: "entero" },
            { etiqueta: "Ticket promedio", valor: 1353, formato: "moneda" },
          ],
        },
        {
          tipo: "callout",
          tono: "alerta",
          titulo: "2 fotos salieron borrosas",
          texto:
            'No pudimos leer el monto con seguridad. Las dejamos en la hoja "A revisar" para que las captures a mano o subas una foto mejor.',
        },
        {
          tipo: "barras",
          titulo: "Gasto por categoría",
          formato: "moneda",
          datos: [
            { etiqueta: "Cocina", valor: 8420 },
            { etiqueta: "Limpieza", valor: 3860 },
            { etiqueta: "Mantto.", valor: 2940 },
            { etiqueta: "Papelería", valor: 2120 },
            { etiqueta: "Otros", valor: 1600 },
          ],
        },
        {
          tipo: "tabla",
          titulo: "Los gastos que leímos",
          columnas: [
            { campo: "fecha", etiqueta: "Fecha" },
            { campo: "proveedor", etiqueta: "Proveedor" },
            { campo: "categoria", etiqueta: "Categoría" },
            { campo: "monto", etiqueta: "Monto", alinear: "derecha", formato: "moneda" },
            { campo: "estatus", etiqueta: "Lectura", formato: "estado" },
          ],
          filas: [
            { fecha: "3 mar", proveedor: "Central de Abastos", categoria: "Cocina", monto: 2840, estatus: "Al día" },
            { fecha: "5 mar", proveedor: "Distribuidora Sabores", categoria: "Cocina", monto: 1650, estatus: "Al día" },
            { fecha: "7 mar", proveedor: "Cloro y Más", categoria: "Limpieza", monto: 980, estatus: "Al día" },
            { fecha: "9 mar", proveedor: "Ferretería El Tornillo", categoria: "Mantto.", monto: 1420, estatus: "Al día" },
            { fecha: "11 mar", proveedor: "(borroso)", categoria: "Sin clasificar", monto: "—", estatus: "Revisar" },
          ],
        },
      ],
      archivoSalida: "gastos-marzo.xlsx",
    },
    historial: [
      { fecha: "16 mar 2026", archivo: "tickets-marzo (16 fotos)", duracion: "44 s", estado: "Correcta", por: "carmen" },
      { fecha: "2 mar 2026", archivo: "tickets-feb (11 fotos)", duracion: "38 s", estado: "Correcta", por: "carmen" },
    ],
    cambios: [
      { version: 1, titulo: "Construcción original", fecha: "10 mar 2026", tipo: "construccion" },
      { version: 2, titulo: "Detectar y apartar las fotos borrosas", fecha: "14 mar 2026", tipo: "ajuste" },
    ],
  },
  {
    id: "comisiones-ventas",
    nombre: "Cálculo de comisiones por vendedor",
    descripcion:
      "Toma tus ventas del periodo y calcula la comisión de cada vendedor con tu esquema, y aparta las ventas sin vendedor para que las revises.",
    estado: "lista",
    creada: "6 mar 2026",
    ejecuciones: 5,
    ultimaEjecucion: "hace 2 días",
    ajustesUsados: 0,
    entradas: [
      {
        id: "ventas",
        tipo: "archivo",
        etiqueta: "Tu archivo de ventas del periodo",
        ayuda: "El export de tu sistema, en Excel o CSV",
        formatos: ["xlsx", "csv"],
      },
      {
        id: "esquema",
        tipo: "seleccion",
        etiqueta: "¿Cómo calculas la comisión?",
        opciones: [
          { valor: "escalonado", etiqueta: "Escalonado por volumen" },
          { valor: "plano", etiqueta: "% plano por vendedor" },
          { valor: "producto", etiqueta: "% por producto" },
        ],
      },
      {
        id: "tipo",
        tipo: "seleccion",
        etiqueta: "¿Cómo les pagas?",
        opciones: [
          { valor: "externo", etiqueta: "Comisionistas externos (facturan)" },
          { valor: "empleado", etiqueta: "Empleados (por nómina)" },
        ],
      },
    ],
    resultado: {
      bloques: [
        {
          tipo: "resumen",
          texto:
            "Calculamos $14,163 en comisiones brutas para 4 comisionistas externos con el esquema escalonado. Tras las retenciones de ISR e IVA ($2,927 a enterar al SAT), el neto a pagar es $13,502. 2 ventas venían sin vendedor y las apartamos para que las revises.",
        },
        {
          tipo: "metricas",
          items: [
            { etiqueta: "Comisión bruta", valor: 14163, formato: "moneda" },
            {
              etiqueta: "Retenciones ISR + IVA",
              valor: 2927,
              formato: "moneda",
              nota: "A enterar al SAT",
            },
            { etiqueta: "Neto a pagar", valor: 13502, formato: "moneda" },
            { etiqueta: "Comisionistas", valor: 4, formato: "entero" },
          ],
        },
        {
          tipo: "callout",
          tono: "alerta",
          titulo: "2 ventas sin vendedor asignado",
          texto:
            'No pudimos calcularles comisión porque no traían vendedor. Las dejamos en "a revisar" para que las asignes y se recalculen.',
        },
        {
          tipo: "ranking",
          titulo: "Comisión por vendedor",
          formato: "moneda",
          datos: [
            { etiqueta: "Ana Ruiz", valor: 4423 },
            { etiqueta: "Luis Mora", valor: 3865 },
            { etiqueta: "Carmen Díaz", valor: 3249 },
            { etiqueta: "Jorge Peña", valor: 2626 },
          ],
        },
        {
          tipo: "tabla",
          titulo: "Desglose por vendedor",
          columnas: [
            { campo: "vendedor", etiqueta: "Vendedor" },
            { campo: "ventas", etiqueta: "Ventas", alinear: "derecha", formato: "moneda" },
            { campo: "regla", etiqueta: "Regla aplicada" },
            { campo: "comision", etiqueta: "Comisión bruta", alinear: "derecha", formato: "moneda" },
            { campo: "estatus", etiqueta: "Pago", formato: "estado" },
          ],
          filas: [
            { vendedor: "Ana Ruiz", ventas: 128450, regla: "3% + 5% excedente", comision: 4423, estatus: "Pagado" },
            { vendedor: "Luis Mora", ventas: 117300, regla: "3% + 5% excedente", comision: 3865, estatus: "Pagado" },
            { vendedor: "Carmen Díaz", ventas: 104980, regla: "3% + 5% excedente", comision: 3249, estatus: "Pendiente" },
            { vendedor: "Jorge Peña", ventas: 87520, regla: "3% (primer tramo)", comision: 2626, estatus: "Pendiente" },
          ],
        },
      ],
      archivoSalida: "comisiones-marzo.xlsx",
    },
    historial: [
      { fecha: "16 mar 2026", archivo: "ventas-marzo.xlsx", duracion: "26 s", estado: "Correcta", por: "ana" },
      { fecha: "1 mar 2026", archivo: "ventas-febrero.xlsx", duracion: "24 s", estado: "Correcta", por: "ana" },
    ],
    cambios: [
      { version: 1, titulo: "Construcción original", fecha: "6 mar 2026", tipo: "construccion" },
    ],
  },
  {
    id: "limpieza-contactos",
    nombre: "Limpieza de lista de contactos",
    descripcion:
      "Quita duplicados, corrige formatos y separa los contactos con datos inválidos para que los revises.",
    estado: "generando",
    creada: "hoy",
    ejecuciones: 0,
    ajustesUsados: 0,
    entradas: [],
    historial: [],
    cambios: [],
  },
  {
    id: "conciliacion-pagos",
    nombre: "Conciliación de pagos",
    descripcion:
      "Cruza los pagos recibidos con tu estado de cuenta y marca lo que no cuadra.",
    estado: "fallo",
    creada: "ayer",
    ejecuciones: 0,
    ajustesUsados: 0,
    motivoFallo:
      "No conseguimos que el resultado cumpliera tus criterios después de 4 intentos. Suele resolverse dando un poco más de detalle sobre el formato de tu estado de cuenta. Reintentar es gratis.",
    entradas: [],
    historial: [],
    cambios: [],
  },
  {
    id: "inventario-semanal",
    nombre: "Alerta semanal de inventario bajo",
    descripcion:
      "Cruza el inventario con las ventas de la semana y te dice qué productos están por agotarse.",
    estado: "congelada",
    creada: "8 ene 2026",
    ejecuciones: 87,
    ultimaEjecucion: "hace 3 horas",
    ajustesUsados: 3,
    entradas: [
      {
        id: "inventario",
        tipo: "archivo",
        etiqueta: "Tu inventario actual",
        formatos: ["csv", "xlsx"],
      },
      {
        id: "ventas",
        tipo: "archivo",
        etiqueta: "Las ventas de la semana",
        formatos: ["csv", "xlsx"],
      },
    ],
    resultado: {
      bloques: [
        {
          tipo: "resumen",
          texto:
            "De 1,240 productos, 18 se agotan esta semana y ponen en riesgo $96,400 en ventas. Bebidas y lácteos son los más apretados. Otros 34 traen sobre-stock que puedes frenar.",
        },
        {
          tipo: "metricas",
          items: [
            { etiqueta: "Productos revisados", valor: 1240, formato: "entero" },
            { etiqueta: "Por agotarse", valor: 18, formato: "entero" },
            { etiqueta: "Con sobre-stock", valor: 34, formato: "entero" },
            {
              etiqueta: "Valor en riesgo",
              valor: 96400,
              formato: "moneda",
              nota: "Ventas que se perderían",
            },
          ],
        },
        {
          tipo: "callout",
          tono: "alerta",
          titulo: "4 productos se agotan en 3 días o menos",
          texto:
            "Agua 1 L, leche entera, refresco cola y detergente. Conviene resurtir antes del fin de semana.",
        },
        {
          tipo: "barras",
          titulo: "Por agotarse, por categoría",
          formato: "entero",
          datos: [
            { etiqueta: "Bebidas", valor: 6 },
            { etiqueta: "Lácteos", valor: 4 },
            { etiqueta: "Abarrotes", valor: 4 },
            { etiqueta: "Limpieza", valor: 2 },
            { etiqueta: "Botanas", valor: 2 },
          ],
        },
        {
          tipo: "tabla",
          titulo: "Los más urgentes",
          columnas: [
            { campo: "producto", etiqueta: "Producto" },
            { campo: "categoria", etiqueta: "Categoría" },
            { campo: "existencia", etiqueta: "Existencia", alinear: "derecha", formato: "entero" },
            { campo: "dias", etiqueta: "Días restantes", alinear: "derecha", formato: "entero" },
            { campo: "urgencia", etiqueta: "Urgencia", formato: "estado" },
          ],
          filas: [
            { producto: "Agua 1 L (caja)", categoria: "Bebidas", existencia: 14, dias: 2, urgencia: "Urgente" },
            { producto: "Leche entera 1 L", categoria: "Lácteos", existencia: 22, dias: 3, urgencia: "Urgente" },
            { producto: "Refresco cola 600 ml", categoria: "Bebidas", existencia: 31, dias: 3, urgencia: "Pronto" },
            { producto: "Detergente 1 kg", categoria: "Limpieza", existencia: 9, dias: 4, urgencia: "Pronto" },
            { producto: "Arroz 1 kg", categoria: "Abarrotes", existencia: 18, dias: 5, urgencia: "Al día" },
          ],
        },
      ],
      archivoSalida: "alerta-inventario.xlsx",
    },
    historial: [
      { fecha: "17 mar 2026", archivo: "inventario+ventas (2 archivos)", duracion: "38 s", estado: "Correcta", por: "jorge" },
      { fecha: "10 mar 2026", archivo: "inventario+ventas (2 archivos)", duracion: "36 s", estado: "Correcta", por: "jorge" },
      { fecha: "3 mar 2026", archivo: "inventario+ventas (2 archivos)", duracion: "41 s", estado: "Correcta", por: "carmen" },
    ],
    cambios: [
      { version: 1, titulo: "Construcción original", fecha: "8 ene 2026", tipo: "construccion" },
      { version: 2, titulo: "Agregar la columna de días restantes", fecha: "12 ene 2026", tipo: "ajuste" },
      { version: 3, titulo: "Separar el sobre-stock en su propia lista", fecha: "20 ene 2026", tipo: "ajuste" },
      { version: 4, titulo: "Ordenar por urgencia en vez de por nombre", fecha: "2 feb 2026", tipo: "ajuste" },
    ],
  },
];

export const obtenerAutomatizacion = (id: string) =>
  automatizaciones.find((a) => a.id === id);

// ── Entrevista (flujo /nueva) ───────────────────────────────────────────────

export interface OpcionEntrevista {
  id: string;
  etiqueta: string;
  detalle: string;
  recomendada?: boolean;
}

export interface PreguntaEntrevista {
  id: string;
  titulo: string;
  ayuda?: string;
  tipo: "opciones" | "archivo";
  permiteOtro?: boolean;
  opciones?: OpcionEntrevista[];
}

// Preguntas en lenguaje de negocio — nunca técnicas. El límite de 10 es un
// techo; aquí son 5 (4 de opciones + 1 de archivo), en dos rondas.
export const rondasEntrevista: PreguntaEntrevista[][] = [
  [
    {
      id: "frecuencia",
      titulo: "¿Cada cuándo haces este proceso hoy?",
      tipo: "opciones",
      permiteOtro: true,
      opciones: [
        { id: "diario", etiqueta: "Todos los días", detalle: "Una o varias veces al día" },
        { id: "semanal", etiqueta: "Cada semana", detalle: "Un día fijo, por ejemplo los lunes" },
        { id: "mensual", etiqueta: "Cada mes", detalle: "Al cierre o al inicio del mes" },
        { id: "acumula", etiqueta: "Cuando se junta", detalle: "No tiene fecha fija" },
      ],
    },
    {
      id: "resultado",
      titulo: "¿Cómo quieres recibir el resultado?",
      tipo: "opciones",
      permiteOtro: true,
      opciones: [
        {
          id: "hoja",
          etiqueta: "Una hoja de cálculo",
          detalle: "La descargas y la abres en Excel",
          recomendada: true,
        },
        { id: "documento", etiqueta: "Un documento", detalle: "Un PDF listo para compartir" },
        { id: "pantalla", etiqueta: "Solo verlo en pantalla", detalle: "Métricas y tablas aquí mismo" },
      ],
    },
    {
      id: "datos-raros",
      titulo: "Si un dato viene raro o incompleto, ¿qué hacemos?",
      tipo: "opciones",
      permiteOtro: true,
      opciones: [
        {
          id: "saltar",
          etiqueta: "Lo saltamos y te avisamos al final",
          detalle: "El proceso no se detiene",
          recomendada: true,
        },
        { id: "detener", etiqueta: "Detienen todo y me avisan", detalle: "Nada avanza hasta que lo revises" },
        { id: "marcar", etiqueta: "Lo incluyen marcado", detalle: "Lo verás resaltado en el resultado" },
      ],
    },
  ],
  [
    {
      id: "origen",
      titulo: "¿De dónde sale la información?",
      tipo: "opciones",
      permiteOtro: true,
      opciones: [
        {
          id: "archivo",
          etiqueta: "De un archivo que subo yo",
          detalle: "Excel, CSV o similar",
          recomendada: true,
        },
        { id: "varios", etiqueta: "De varios archivos", detalle: "Se combinan entre sí" },
        { id: "mano", etiqueta: "La capturo a mano", detalle: "Un formulario corto aquí mismo" },
      ],
    },
    {
      id: "ejemplo",
      titulo: "Sube un archivo de ejemplo",
      ayuda:
        "Con un ejemplo real entendemos tu proceso a la primera. Puedes quitarle los datos sensibles — solo necesitamos la forma.",
      tipo: "archivo",
    },
  ],
];

// Resumen que "produce" la entrevista (pantalla de aprobación).
export const specResumen = {
  objetivo:
    "Convertir tu archivo de ventas en un reporte mensual por vendedor, listo para descargar.",
  entradas: ["Tu archivo de ventas (Excel o CSV)", "El mes que quieres reportar"],
  salidas: [
    "Una hoja de cálculo con el total por vendedor",
    "Métricas y gráfica aquí, en tu portafolio",
  ],
  reglas: [
    "Las ventas canceladas no se cuentan",
    "Si un dato viene raro, lo saltamos y te avisamos al final",
  ],
  criterios: [
    "Hay una fila por cada vendedor",
    "Los totales cuadran con el archivo original",
    "Las canceladas quedan fuera del cálculo",
  ],
};

// Ideas de ejemplo: chips clicables + placeholder animado del textarea.
export const ejemplosIdea = [
  "Cada mes junto las ventas de mis 4 vendedores en un solo Excel y saco totales por persona… me toma toda una tarde.",
  "Le tomo foto a los tickets de gasto y alguien los captura a mano en una tabla; quiero que se haga solo.",
  "Recibo facturas de muchos proveedores y necesito un consolidado con IVA, agrupado por RFC.",
  "Tengo una lista de contactos llena de duplicados y correos mal escritos que quiero limpiar.",
];

// ── Precios ─────────────────────────────────────────────────────────────────

export interface Plan {
  id: string;
  nombre: string;
  precioMes: number;
  precioAnual: number; // por mes, facturado anual
  espacios: number;
  usuarios: number;
  descripcion: string;
  rasgos: string[];
  destacado?: boolean;
}

export const planes: Plan[] = [
  {
    id: "base",
    nombre: "Base",
    precioMes: 499,
    precioAnual: 415,
    espacios: 3,
    usuarios: 1,
    descripcion: "Para quitarte de encima tus procesos de todos los días.",
    rasgos: [
      "3 automatizaciones activas",
      "1 construcción + 3 ajustes por automatización",
      "Ejecuciones sin límite",
      "Reparaciones gratis, siempre",
      "1 usuario",
    ],
  },
  {
    id: "pro",
    nombre: "Pro",
    precioMes: 999,
    precioAnual: 832,
    espacios: 6,
    usuarios: 3,
    descripcion: "Para equipos que ya automatizan varias áreas.",
    destacado: true,
    rasgos: [
      "6 automatizaciones activas",
      "1 construcción + 3 ajustes por automatización",
      "Ejecuciones sin límite",
      "Reparaciones gratis, siempre",
      "3 usuarios",
      "Soporte prioritario",
    ],
  },
  {
    id: "equipo",
    nombre: "Equipo",
    precioMes: 1999,
    precioAnual: 1665,
    espacios: 10,
    usuarios: 10,
    descripcion: "Para operaciones donde varias personas ejecutan a diario.",
    rasgos: [
      "10 automatizaciones activas",
      "1 construcción + 3 ajustes por automatización",
      "Ejecuciones sin límite",
      "Reparaciones gratis, siempre",
      "10 usuarios",
      "Soporte prioritario",
      "Exportar el código de tus automatizaciones",
    ],
  },
];

export const faq = [
  {
    pregunta: "¿Qué cuenta como un ajuste?",
    respuesta:
      "Un cambio sobre algo que ya funciona: «agrégale el promedio», «agrúpalo por región». Cada automatización incluye su construcción y hasta 3 ajustes. Cuando algo deja de funcionar sin que tú cambiaras nada, eso es una reparación — y las reparaciones son gratis, siempre.",
  },
  {
    pregunta: "¿Qué pasa si no queda a la primera?",
    respuesta:
      "Reintentar no cuesta: los intentos fallidos no consumen nada de tu plan. Solo ocupan espacio las automatizaciones que funcionan.",
  },
  {
    pregunta: "¿Necesito saber de tecnología?",
    respuesta:
      "No. Describes tu proceso como se lo contarías a un compañero nuevo, contestas unas preguntas sencillas y listo. Nunca verás una línea de código.",
  },
  {
    pregunta: "¿Mis datos están seguros?",
    respuesta:
      "Tus archivos viven aislados de los de otros clientes, y cada ejecución corre en un entorno separado que se destruye al terminar.",
  },
  {
    pregunta: "¿Puedo cancelar cuando quiera?",
    respuesta:
      "Sí. Y conservas acceso de solo lectura durante 30 días para descargar todos tus resultados.",
  },
];

// Pasos para la marquesina de la landing.
export const pasosMarquesina = [
  "Descríbelo una vez",
  "Responde 3 preguntas",
  "Los agentes lo construyen",
  "Ejecútala cuando quieras",
  "Reparaciones gratis",
];

// ── Equipo (multi-usuario) ──────────────────────────────────────────────────
// La cuenta es del NEGOCIO; el portafolio es compartido por todo el equipo.
// Dos roles: admin (crea, ajusta, invita, factura) y operador (solo ejecuta).

export type RolMiembro = "admin" | "operador";
export type EstadoMiembro = "activo" | "pendiente";

export interface Miembro {
  id: string;
  nombre: string;
  correo: string;
  rol: RolMiembro;
  estado: EstadoMiembro;
}

export const organizacion = {
  nombre: "Hotel Vitrales",
  plan: "Equipo",
  lugaresTotal: 10,
};

export const usuarioActualId = "ana";

export const equipo: Miembro[] = [
  { id: "ana", nombre: "Ana Rivera", correo: "ana@hotelvitrales.mx", rol: "admin", estado: "activo" },
  { id: "luis", nombre: "Luis Mendoza", correo: "luis@hotelvitrales.mx", rol: "operador", estado: "activo" },
  { id: "carmen", nombre: "Carmen Solís", correo: "carmen@hotelvitrales.mx", rol: "operador", estado: "activo" },
  { id: "jorge", nombre: "Jorge Peña", correo: "jorge@hotelvitrales.mx", rol: "operador", estado: "activo" },
  { id: "roberto", nombre: "Roberto Lara", correo: "roberto@hotelvitrales.mx", rol: "operador", estado: "pendiente" },
];

export const obtenerMiembro = (id: string) => equipo.find((m) => m.id === id);
export const usuarioActual = () => obtenerMiembro(usuarioActualId)!;

// ── Cuenta y plan (vista de cliente activo) ─────────────────────────────────

export const cuenta = {
  plan: "Equipo",
  precioMes: 1999,
  cicloRenovacion: "mensual" as const,
  proximaRenovacion: "18 de abril, 2026",
  metodoPago: { tipo: "Visa", ultimos4: "4291" },
  automatizacionesActivas: 4, // listas + congeladas
  espaciosTotal: 10,
  ejecucionesMes: 342,
  ejecucionesTotal: 10000,
};

// Historial de pagos (demo).
export const pagos = [
  { fecha: "18 mar 2026", concepto: "Plan Equipo — mensual", monto: 1999, estado: "Pagado" },
  { fecha: "18 feb 2026", concepto: "Plan Equipo — mensual", monto: 1999, estado: "Pagado" },
  { fecha: "18 ene 2026", concepto: "Plan Equipo — mensual", monto: 1999, estado: "Pagado" },
];

// ── Actividad reciente (panel de inicio) ────────────────────────────────────

export type TipoActividad = "ejecucion" | "ajuste" | "nueva" | "invitacion";

export interface EventoActividad {
  miembroId: string;
  tipo: TipoActividad;
  objeto: string; // nombre de la automatización o persona
  cuando: string;
}

export const actividadReciente: EventoActividad[] = [
  { miembroId: "luis", tipo: "ejecucion", objeto: "Reporte mensual de ventas", cuando: "hace 2 horas" },
  { miembroId: "jorge", tipo: "ejecucion", objeto: "Alerta semanal de inventario bajo", cuando: "hace 3 horas" },
  { miembroId: "carmen", tipo: "ejecucion", objeto: "Consolidado de facturas por proveedor", cuando: "hace 5 horas" },
  { miembroId: "ana", tipo: "invitacion", objeto: "Roberto Lara", cuando: "ayer" },
  { miembroId: "luis", tipo: "ejecucion", objeto: "Reporte mensual de ventas", cuando: "ayer" },
  { miembroId: "ana", tipo: "ajuste", objeto: "Reporte mensual de ventas", cuando: "hace 3 días" },
];

// Quién creó cada automatización (solo los admin crean).
export const creadoPor: Record<string, string> = {
  "reporte-ventas": "ana",
  "consolidado-facturas": "ana",
  "limpieza-contactos": "ana",
  "conciliacion-pagos": "ana",
  "inventario-semanal": "ana",
};
