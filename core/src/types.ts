// ─────────────────────────────────────────────────────────────────────────────
// Contrato del core (M0). Todos los módulos cuelgan de estos tipos.
// Los "puertos" (Storage/StateRepo/BuildClient/RunExecutor) son interfaces para
// intercambiar implementación: local FS ↔ R2, memoria ↔ Neon, CMA ↔ runner propio.
// ─────────────────────────────────────────────────────────────────────────────

// ── Bloques de vista (copia EXACTA del contrato del front: web/lib/datos.ts) ──
// El resolver produce este tipo; el front ya sabe renderizarlo.

export interface MetricaDemo {
  etiqueta: string;
  valor: number;
  formato: "moneda" | "entero";
  sufijo?: string;
  nota?: string;
  tendencia?: string;
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

/** Lo que el resolver emite: exactamente lo que el front consume. */
export interface Resultado {
  bloques: Bloque[];
  archivoSalida: string;
}

// ── La VISTA declarada (vista.json). Igual que Bloque pero con referencias
// @resultado.* en vez de datos, y con `fuente`/`eje_*` para gráficas y tablas.
// El resolver la aterriza en Resultado (docs/09). Una referencia es el string
// "@resultado.<ruta.con.puntos>".

export type Ref = string; // "@resultado.metricas.ingreso_total"

export interface VistaMetrica {
  etiqueta: string;
  valor: Ref | number;
  formato: "moneda" | "entero";
  sufijo?: Ref | string;
  nota?: Ref | string;
  tendencia?: Ref | string;
}

export type VistaBloque =
  | { tipo: "resumen"; texto: Ref | string }
  | { tipo: "metricas"; items: VistaMetrica[] }
  | { tipo: "callout"; tono: "info" | "ok" | "alerta"; titulo: Ref | string; texto?: Ref | string }
  | {
      tipo: "barras" | "linea" | "ranking";
      titulo: string;
      formato: "moneda" | "entero";
      fuente: Ref; // apunta a un arreglo en el resultado
      eje_x: string; // campo de cada item -> etiqueta
      eje_y: string; // campo de cada item -> valor
      limite?: number; // top N
    }
  | {
      tipo: "tabla";
      titulo?: string;
      fuente: Ref; // arreglo
      columnas: ColumnaDemo[]; // `campo` proyecta cada item
      limite?: number;
    }
  | {
      tipo: "comparacion";
      titulo: string;
      pasos: { etiqueta: string; valor: Ref | number; tono?: "ok" | "alerta" | "neutro" }[];
    };

export interface Vista {
  version_vista: number;
  titulo: string;
  archivoSalida: string;
  bloques: VistaBloque[];
}

// ── Manifiesto (qué insumos necesita el artefacto para correr). docs/01/09. ──

export interface EntradaManifiesto {
  nombre: string;
  tipo: "archivo" | "texto" | "numero";
  formato?: string;
  descripcion: string;
  requerido: boolean;
}

export interface Manifiesto {
  entradas: EntradaManifiesto[];
}

// ── Spec (lo que el intake produce; en M0 va a mano, como spike/casos.js). ──

export interface Spec {
  objetivo: string;
  reglas: string[];
  criterios_exito: string[];
  entradas: { tipo: string; formato: string; descripcion: string }[];
}

// ── Artefacto (lo que el Builder entrega; docs/01). En M0 vive en Storage. ──

export interface Artefacto {
  automatizacionPy: string; // el script reutilizable
  manifiesto: Manifiesto;
  vista: Vista;
  requirements?: string; // pip, opcional en M0
}

// ── Registros de estado (schema mínimo M0). Neon en M2; en M0 en memoria. ──

// 'ready' lo escribe el pipeline (build inicial); 'lista' el servicio de ciclo (ajustes).
// Ambos = "el cliente ya la puede usar" (trg_marcar_entrega acepta los dos).
export type EstadoBuild = "queued" | "building" | "ready" | "lista" | "failed";

export interface Automatizacion {
  id: string;
  orgId: string;
  nombre: string;
  versionActual?: string;
  // CON QUÉ SE CONSTRUYÓ, para que un AJUSTE pueda reconstruir: mismo spec (que el Verifier juzgue
  // contra los mismos criterios) y mismo ejemplo (probar la versión nueva con los datos del
  // cliente). Su otra copia, build_pendiente, se borra al drenar.
  spec?: Spec;
  ejemploKey?: string;
}

export interface Version {
  id: string;
  automatizacionId: string;
  numero: number;
  estado: EstadoBuild;
  artefactoKey?: string; // clave en Storage
  vista?: Vista; // a3: persistida al ARRANCAR, para ensamblar el Artefacto en la cosecha
  cmaSessionId?: string; // a3: sesión de CMA (write-once vía app_fijar_sesion_cma)
  creada: string;
}

export interface Ejecucion {
  id: string;
  versionId: string;
  // 'reservada' = asiento creado ANTES de correr (dispara el freno/kill-switch en la
  // BD antes de ejecutar el código de IA); pasa a 'ok'/'fallo' al terminar el run.
  estado: "reservada" | "ok" | "fallo";
  resultadoKey?: string;
  ms: number;
  costoUsd: number; // costo del Run (session-hours); 0 si es pura ejecución local
  creada: string;
}

// ── Puertos (interfaces para intercambiar implementación) ──

/** Blob store para artefactos y salidas. Local FS en M0; R2 (S3) en producción. */
export interface Storage {
  put(key: string, data: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer>;
  getText(key: string): Promise<string>;
  list(prefix: string): Promise<string[]>;
  /** ¿Existen los bytes? (a3) La cosecha lo usa como guard: NO marcar una versión 'lista'
   *  si el artefacto no subió a storage (evita una versión no ejecutable). */
  existe(key: string): Promise<boolean>;
}

/** Estado. Memoria/archivo en M0; Postgres/Neon con RLS en M2. */
export interface StateRepo {
  crearAutomatizacion(a: Omit<Automatizacion, "id">): Promise<Automatizacion>;
  /** Desactiva (activa=false) una automatización: la compensación de `construir` cuando el
   *  build falla, para devolver el espacio del plan (una activa sin build lo consumiría). */
  desactivarAutomatizacion(id: string): Promise<void>;
  crearVersion(v: Omit<Version, "id">): Promise<Version>;
  actualizarVersion(id: string, cambios: Partial<Version>): Promise<Version>;
  /** Graba la sesión de CMA en la versión (build-start async, a3). Write-once vía el SD
   *  app_fijar_sesion_cma: lanza si la versión no está 'building' o ya tiene sesión. */
  fijarSesionCma(versionId: string, sessionId: string): Promise<void>;
  crearEjecucion(e: Omit<Ejecucion, "id">): Promise<Ejecucion>;
  actualizarEjecucion(id: string, cambios: Partial<Ejecucion>): Promise<Ejecucion>;
  obtenerVersion(id: string): Promise<Version | undefined>;
}

/** Lo que el Builder entrega: el código + manifiesto. La `vista` la adjunta el
 * pipeline (en M1 la producirá el planner; en M0 se provee a mano). */
export interface CodigoConstruido {
  automatizacionPy: string;
  manifiesto: Manifiesto;
  requirements?: string;
}

/** Construye el código a partir de un spec. CMA en M0; runner propio en Fase 2.
 * `contratoTexto` (del planner) le dice al builder qué forma debe tener el
 * resultado.json para que la vista resuelva. */
export interface BuildClient {
  build(
    spec: Spec,
    ejemploPath: string,
    contratoTexto?: string,
  ): Promise<{ codigo: CodigoConstruido; costoUsd: number; iteraciones: number; aprobado: boolean }>;
}

/** Lo que el arranque asíncrono devuelve: el id de la sesión de build, que se graba
 *  como `versiones.cma_session_id`. El webhook de fin-de-sesión (thin) trae ese id;
 *  por ahí se mapea de vuelta a la versión. NO se espera a que termine. */
export interface ArranqueBuild {
  sessionId: string;
}

/** Resultado de cosechar una sesión de build ya terminada. Es un tipo DISCRIMINADO:
 *  - `satisfecho`: el grader aprobó → hay `codigo` para subir a storage.
 *  - `fallido`: el grader agotó iteraciones / falló / se interrumpió, o la sesión
 *    terminó con error → NO hay código; `motivo` explica.
 *  - `en_curso`: la sesión NO está en un estado terminal (p.ej. idle esperando una
 *    acción). El llamador NO debe confirmar ni fallar todavía; reintenta luego. */
export type ResultadoCosecha =
  | { estado: "satisfecho"; codigo: CodigoConstruido; costoUsd: number; iteraciones: number }
  | { estado: "fallido"; motivo: string; iteraciones: number }
  | { estado: "en_curso" };

/** BuildClient de PRODUCCIÓN: el build es asíncrono (arranca → webhook → cosecha),
 *  no un bloqueo de ~10 min. `build()` (síncrono) se conserva para M0/pruebas. La
 *  cosecha vive aquí (y no en la orquestación) porque es específica del SDK de CMA:
 *  hay que RE-CONSULTAR la sesión para saber el desenlace real (el webhook es thin) y
 *  descargar los archivos de salida. */
/** Un build de AJUSTE no parte de cero: la automatización ya existe y el cliente pidió un cambio
 *  concreto ("además quiero el promedio"). Se le da al agente el código de la versión vigente para
 *  que la MODIFIQUE en vez de reinventarla — si no, cada ajuste sería una automatización distinta
 *  con el mismo nombre y el cliente perdería el comportamiento que ya había aprobado. */
export interface PeticionAjuste {
  peticion: string; // lo que el cliente escribió, en sus palabras
  codigoAnterior?: string; // el artefacto vigente (si se pudo recuperar del storage)
  numeroVersion: number; // 2, 3, 4… para que el prompt sepa que es una revisión
}

export interface BuildClientAsync extends BuildClient {
  arrancar(spec: Spec, ejemploPath: string, contratoTexto?: string, ajuste?: PeticionAjuste): Promise<ArranqueBuild>;
  cosechar(sessionId: string): Promise<ResultadoCosecha>;
}

/** Ejecuta el artefacto sobre insumos. Codigo puro, SIN modelo. */
export interface RunExecutor {
  run(
    artefacto: Artefacto,
    inputs: Record<string, string>, // nombre -> ruta de archivo local
  ): Promise<{ resultado: unknown; ms: number; costoUsd: number; salidas: string[] }>;
}
