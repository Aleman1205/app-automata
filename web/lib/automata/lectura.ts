import { intakeSpecABuildSpec } from "automata-core/intake/adapter";
import type { IntakeSpec } from "automata-core/intake/schema";
import type { DatosTarjeta } from "@/app/portafolio/_componentes/tarjeta-automatizacion";
import type {
  Automatizacion,
  CambioVersion,
  EjecucionPrevia,
  EstadoAuto,
  ResultadoDemo,
} from "@/lib/datos";

// ─────────────────────────────────────────────────────────────────────────────
// Capa de LECTURA del front: pega a las APIs reales (GET) y mapea la respuesta a las formas
// que la UI ya sabe renderizar. Si no hay org (sin login / sin backend) o el fetch falla,
// devuelve null → el llamador cae a los datos falsos de lib/datos (el prototipo sigue vivo).
//
// La org YA NO es una env clavada: se resuelve al vuelo desde la MEMBRESÍA del usuario vía
// GET /api/yo (que además hace onboarding si es su primer acceso). Funciona igual en modo dev
// (usuario sembrado) y con Clerk real (la org del usuario que inició sesión). Se cachea por
// carga de página (una sola llamada a /api/yo); null cacheado = sin backend/login → datos falsos.
// ─────────────────────────────────────────────────────────────────────────────

let orgPromesa: Promise<string | null> | undefined;
async function orgActual(): Promise<string | null> {
  return (orgPromesa ??= (async () => {
    try {
      const r = await fetch("/api/yo", { headers: { accept: "application/json" }, cache: "no-store" });
      if (!r.ok) return null;
      const d = (await r.json()) as { orgs?: { id: string }[] };
      return d.orgs?.[0]?.id ?? null;
    } catch {
      return null; // sin backend / red caída → el llamador usa datos falsos
    }
  })());
}

interface AutomatizacionApi {
  id: string;
  nombre: string;
  estado: EstadoAuto;
  ejecuciones: number;
  ajustesUsados: number;
  creada: string | null;
}

// El backend no guarda una "descripción" por automatización (no es una columna); mostramos
// una línea por ESTADO para que la tarjeta no quede vacía. No es dato inventado del negocio,
// es texto de presentación del estado.
const DESCRIPCION: Record<EstadoAuto, string> = {
  lista: "Lista para ejecutar cuando la necesites.",
  generando: "La estamos construyendo a partir de lo que nos contaste.",
  congelada: "Versión definitiva. Ejecútala y descarga resultados.",
  fallo: "Algo salió mal al construirla. Puedes reintentar gratis.",
};

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (dias <= 0) return "hoy";
  if (dias === 1) return "ayer";
  if (dias < 7) return `hace ${dias} días`;
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

/** Lista las automatizaciones de la org (API real). null → sin backend/org: usa datos falsos. */
export async function listarAutomatizaciones(): Promise<DatosTarjeta[] | null> {
  const org = await orgActual();
  if (!org) return null;
  try {
    const r = await fetch(`/api/orgs/${org}/automatizaciones`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return null;
    const data = (await r.json()) as { automatizaciones: AutomatizacionApi[] };
    return data.automatizaciones.map((a) => ({
      id: a.id,
      nombre: a.nombre,
      estado: a.estado,
      descripcion: DESCRIPCION[a.estado] ?? "",
      creada: fechaCorta(a.creada),
      ejecuciones: a.ejecuciones,
      ajustesUsados: a.ajustesUsados,
    }));
  } catch {
    return null; // red caída / JSON inválido → fallback a datos falsos
  }
}

// ── Cuenta (plan + límites + uso) ────────────────────────────────────────────
// El backend NO guarda precio ni método de pago ni historial (eso es Stripe); sí el plan,
// los LÍMITES del plan y el CONSUMO real. El precio se deriva del plan (docs/06, MXN provisional).
export interface CuentaVista {
  plan: string;
  precioMes: number;
  proximaRenovacion: string | null;
  espaciosUsados: number; espaciosTotal: number;
  ejecucionesMes: number; ejecucionesTotal: number;
  usuariosUsados: number; usuariosTotal: number;
}
const PRECIO_MES: Record<string, number> = { base: 499, pro: 999, equipo: 1999 };
const TITULO_PLAN: Record<string, string> = { base: "Base", pro: "Pro", equipo: "Equipo" };
const fechaLarga = (iso: string): string =>
  new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });

export async function verCuenta(): Promise<CuentaVista | null> {
  const org = await orgActual();
  if (!org) return null;
  try {
    const r = await fetch(`/api/orgs/${org}/cuenta`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      plan: { clave: string; periodoFin: string | null };
      limites: { espacios: number; ejecuciones: number; usuarios: number };
      uso: { espacios: number; ejecuciones: number; usuarios: number };
    };
    return {
      plan: TITULO_PLAN[d.plan.clave] ?? d.plan.clave,
      precioMes: PRECIO_MES[d.plan.clave] ?? 0,
      proximaRenovacion: d.plan.periodoFin ? fechaLarga(d.plan.periodoFin) : null,
      espaciosUsados: d.uso.espacios, espaciosTotal: d.limites.espacios,
      ejecucionesMes: d.uso.ejecuciones, ejecucionesTotal: d.limites.ejecuciones,
      usuariosUsados: d.uso.usuarios, usuariosTotal: d.limites.usuarios,
    };
  } catch {
    return null;
  }
}

// ── Equipo (miembros) ────────────────────────────────────────────────────────
// El backend solo guarda user_id + rol (nombre/correo son de Clerk). Prettificamos el
// user_id para mostrar (u_luis → "Luis") y marcamos `esTu` desde el API (no un id fijo).
export interface MiembroVista {
  id: string;
  nombre: string;
  correo: string; // vacío en miembros ya registrados (el perfil vive en Clerk); real en pendientes
  rol: "admin" | "operador";
  esTu: boolean;
  pendiente: boolean; // invitación enviada que esa persona aún no acepta
}
const prettyUser = (userId: string): string => {
  const base = userId.replace(/^(u_|user_)/, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
};
// Del correo invitado sale un nombre presentable mientras esa persona no se registra:
// "ana.rivera@hotel.mx" → "Ana Rivera".
const prettyCorreo = (correo: string): string =>
  correo.split("@")[0]!.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || correo;

export async function listarEquipo(): Promise<MiembroVista[] | null> {
  const org = await orgActual();
  if (!org) return null;
  try {
    const r = await fetch(`/api/orgs/${org}/miembros`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      miembros: { userId: string; rol: "admin" | "operador"; esTu: boolean }[];
      invitaciones?: { correo: string; rol: "admin" | "operador" }[];
    };
    const activos: MiembroVista[] = d.miembros.map((m) => ({
      id: m.userId, nombre: prettyUser(m.userId), correo: "", rol: m.rol, esTu: m.esTu, pendiente: false,
    }));
    // Los invitados que aún no aceptan: de ellos SÍ conocemos el correo (es lo único que hay hasta
    // que se registran), y ocupan lugar del plan, así que se muestran como parte del equipo.
    const pendientes: MiembroVista[] = (d.invitaciones ?? []).map((i) => ({
      id: `inv:${i.correo}`, nombre: prettyCorreo(i.correo), correo: i.correo, rol: i.rol, esTu: false, pendiente: true,
    }));
    return [...activos, ...pendientes];
  } catch {
    return null;
  }
}

// ── Detalle de una automatización + ejecución real ───────────────────────────
// El endpoint de detalle da nombre/estado/versiones/conteo, pero NO el manifiesto ni el
// resultado (el manifiesto vive en el artefacto; el resultado nace de una corrida). Para el
// form usamos una entrada de archivo genérica (CSV) y el resultado llega del Run real.
export async function verAutomatizacion(id: string): Promise<Automatizacion | null> {
  const org = await orgActual();
  if (!org) return null;
  try {
    const r = await fetch(`/api/orgs/${org}/automatizacion?id=${encodeURIComponent(id)}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      id: string; nombre: string; estado: EstadoAuto; creada: string | null; ejecuciones: number;
      ultimaEjecucion: string | null; ajustesUsados: number;
      ajustesRestantes?: number; ventanaGratis?: boolean; ventanaHasta?: string | null; enRevision?: boolean;
      cicloEstado?: string;
      versiones: { numero: number; tipo: string | null; creada: string | null }[];
    };
    // El CICLO real, para que la pantalla de ajustes diga la verdad del costo ANTES de que el
    // cliente confirme: dentro de los primeros 30 dias el cambio es GRATIS y no gasta ninguno de
    // los 3 (antes decia "Ajuste 2 de 3" incluso cuando no le iba a costar nada).
    cicloDe.set(d.id, {
      ajustesRestantes: d.ajustesRestantes ?? Math.max(0, 3 - d.ajustesUsados),
      ventanaGratis: !!d.ventanaGratis,
      ventanaHasta: d.ventanaHasta ?? null,
      enRevision: !!d.enRevision,
      congelada: d.cicloEstado === "frozen",
    });
    const cambios: CambioVersion[] = d.versiones
      .slice()
      .sort((a, b) => a.numero - b.numero)
      .map((v) => ({
        version: v.numero,
        titulo: v.tipo === "ajuste" ? "Ajuste aplicado" : "Construcción inicial",
        fecha: fechaCorta(v.creada),
        tipo: v.tipo === "ajuste" ? "ajuste" : "construccion",
      }));
    const historial = await listarEjecuciones(id); // corridas reales, para la tabla del detalle
    return {
      id: d.id,
      nombre: d.nombre,
      descripcion: DESCRIPCION[d.estado] ?? "",
      estado: d.estado,
      creada: fechaCorta(d.creada),
      ejecuciones: d.ejecuciones,
      ultimaEjecucion: d.ultimaEjecucion ? fechaCorta(d.ultimaEjecucion) : undefined,
      ajustesUsados: d.ajustesUsados,
      entradas: [
        // Genérica A PROPÓSITO: el manifiesto real (nombre y formato que espera esta automatización)
        // vive en el artefacto y el endpoint de detalle todavía no lo expone. Antes esto decía "Tu
        // archivo de ventas — CSV con columnas: vendedor, monto" y sólo aceptaba .csv para CUALQUIER
        // automatización: a un hotel con facturas en XML el selector no le dejaba ni escoger su
        // archivo, y el texto describía un proceso que no era el suyo. Mejor pedir el archivo sin
        // inventarle columnas y aceptar lo que el gate admite; el gate rechaza lo que no sirva.
        {
          id: "archivo",
          tipo: "archivo",
          etiqueta: "Tu archivo",
          ayuda: "Sube el archivo que esta automatización procesa (el mismo tipo que nos diste de ejemplo).",
          formatos: ["csv", "xlsx", "xls", "pdf", "txt", "xml", "zip", "jpg", "jpeg", "png"],
        },
      ],
      resultado: undefined, // llega del Run real
      historial,
      cambios,
    };
  } catch {
    return null;
  }
}

/** Ejecuta la automatización subiendo un archivo real → devuelve el Resultado resuelto. */
export async function ejecutarArchivo(automatizacionId: string, file: File): Promise<{ resultado: ResultadoDemo; ms: number }> {
  const org = await orgActual();
  if (!org) throw new Error("No hay backend configurado.");
  const form = new FormData();
  form.append("automatizacionId", automatizacionId);
  form.append("archivo", file);
  const r = await fetch(`/api/orgs/${org}/ejecutar`, { method: "POST", body: form });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    const msg =
      err.error === "entrada_rechazada" ? "El archivo no pasó la validación de seguridad."
      : err.error === "a_revision" ? "El archivo es ilegible; no lo procesamos para no inventar datos."
      : err.error === "cuota_excedida" ? "Alcanzaste el límite de ejecuciones de tu plan este mes."
      : err.error === "sin_version_ejecutable" ? "Esta automatización aún no está lista para ejecutar."
      : "No se pudo ejecutar. Revisa que el archivo tenga las columnas correctas.";
    throw new Error(msg);
  }
  const d = (await r.json()) as { resultado: ResultadoDemo; ms: number };
  return { resultado: d.resultado, ms: d.ms };
}

/** Historial real de corridas de una automatización → filas para la TablaHistorial. El backend
 *  no guarda el nombre del archivo ni quién la corrió por ejecución, así que van como "—". */
export async function listarEjecuciones(automatizacionId: string): Promise<EjecucionPrevia[]> {
  const org = await orgActual();
  if (!org) return [];
  try {
    const r = await fetch(`/api/orgs/${org}/ejecuciones?id=${encodeURIComponent(automatizacionId)}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return [];
    const d = (await r.json()) as { ejecuciones: { id: string; estado: string; ms: number; creada: string | null; tieneResultado?: boolean }[] };
    return d.ejecuciones.map((e) => ({
      id: e.id,
      tieneResultado: !!e.tieneResultado,
      fecha: fechaCorta(e.creada),
      archivo: "—",
      duracion: e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)} s` : `${e.ms} ms`,
      estado: e.estado === "ok" ? "Correcta" : "Falló",
      por: "—", // el backend no guarda quién por ejecución (Clerk); TablaHistorial lo pinta como "—"
    }));
  } catch {
    return [];
  }
}

/** Invita por CORREO (POST /miembros): deja una invitación pendiente que se vuelve membresía cuando
 *  esa persona se registra con ese correo. Antes se mandaba un user_id derivado del correo, que
 *  nunca casaba con el id real de Clerk. Lanza con mensaje de cliente si la cuota/MFA rechaza. */
export async function invitarMiembro(correo: string, rol: "admin" | "operador"): Promise<void> {
  const org = await orgActual();
  if (!org) throw new Error("No hay backend configurado.");
  const r = await pedir(`/api/orgs/${org}/miembros`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ correo, rol }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    const msg =
      err.error === "cuota_excedida" ? "Alcanzaste el límite de personas de tu plan."
      : err.error === "step_up_requerido" ? "Necesitas verificar tu identidad (MFA)."
      : r.status === 400 ? "Revisa el correo: no parece válido."
      : "No se pudo invitar (¿ya está en el equipo?).";
    throw new Error(msg);
  }
}

/** Quita del equipo (DELETE /miembros). Acepta el id de un miembro registrado o `inv:<correo>` para
 *  cancelar una invitación que nadie aceptó (el id que arma listarEquipo). */
export async function quitarMiembro(id: string): Promise<void> {
  const org = await orgActual();
  if (!org) throw new Error("No hay backend configurado.");
  const cuerpo = id.startsWith("inv:") ? { correo: id.slice(4) } : { userId: id };
  const r = await pedir(`/api/orgs/${org}/miembros`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error === "no_puede_quedar_sin_admin" ? "No puedes quitar al único administrador." : "No se pudo quitar.");
  }
}

// ── Intake por-turno (el entrevistador real, Sonnet) ─────────────────────────
export interface OpcionIntake { id: string; etiqueta: string; detalle: string; recomendada: boolean; }
export interface PreguntaIntake { id: string; titulo: string; opciones: OpcionIntake[]; permite_otro: boolean; pide_archivo: boolean; }
// El spec del intake es EL de core (no una copia a mano): así el front no puede desviarse del
// contrato. Traía dos campos por criterio a propósito — `criterio` (técnico, va al rubric del
// Verifier) y `criterio_cliente` (lenguaje natural, va a la pantalla de aprobación) — y una copia
// local que solo declaraba el segundo hizo que el build se verificara contra prosa de cliente.
export type SpecIntake = IntakeSpec;
export interface EntradaHist { pregunta: string; eleccion: string; libre: boolean; }
export type TurnoIntake =
  | { accion: "preguntar"; reencuadre: string | null; preguntas: PreguntaIntake[] }
  | { accion: "cerrar"; spec: SpecIntake; saludo: string }
  | { accion: "rechazar" };

/** Corre UNA ronda del entrevistador. El front manda la idea + el historial acumulado + el
 *  número de turno, y recibe la siguiente ronda de preguntas, o el spec, o un rechazo. */
export async function intakeTurno(idea: string, historial: EntradaHist[], turno: number): Promise<TurnoIntake> {
  const org = await orgActual();
  if (!org) throw new Error("No hay backend configurado (¿modo dev / login?).");
  const r = await fetch(`/api/orgs/${org}/intake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idea, historial, turno }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      err.error === "intake_fallo"
        ? "No pudimos entender del todo tu proceso. Intenta describirlo con otras palabras."
        : "No se pudo procesar la entrevista. Intenta de nuevo.",
    );
  }
  return (await r.json()) as TurnoIntake;
}

// ── Disparar el build (a3-s6): sube el ejemplo → encola la construcción ───────
// Cablea el intake con el backend de build. `subirEjemploArchivo` manda el archivo (multipart)
// al gate + storage (R2 en prod, LocalStorage en dev) y devuelve la ejemploKey; `construirDesdeSpec`
// manda la spec APROBADA + esa clave a POST /construir, que crea la automatización y ENCOLA el
// build (el cron de disparo lo corre fuera del request). Sin esto, aprobar el spec no hacía nada.

const MAX_BYTES_EJEMPLO = 50 * 1024 * 1024; // el tope REAL del gate (core: LIMITES.maxBytesArchivo)
const MAX_NOMBRE = 120; // holgado para leerse en el portafolio; el backend acepta 200

/** Nombre corto y legible para la automatización (lo único que el cliente ve en su portafolio).
 *  Toma la primera oración del objetivo y, si hay que cortar, corta en el último espacio para no
 *  partir una palabra a la mitad. */
function nombreDesdeObjetivo(objetivo: string): string {
  const primera = objetivo.trim().split(/[.\n]/)[0]?.trim() ?? "";
  const base = (primera.length > 0 ? primera : objetivo.trim()).replace(/\s+/g, " ");
  if (base.length === 0) return "Automatización";
  if (base.length <= MAX_NOMBRE) return base;
  const corte = base.slice(0, MAX_NOMBRE);
  const ultimoEspacio = corte.lastIndexOf(" ");
  return `${(ultimoEspacio > MAX_NOMBRE * 0.6 ? corte.slice(0, ultimoEspacio) : corte).trimEnd()}…`;
}

/** Envuelve un fetch para que una red caída no llegue crudo y en inglés ("Failed to fetch") a una
 *  UI en español. Los errores de protocolo (status) los traduce cada llamador. */
async function pedir(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("No pudimos conectar. Revisa tu conexión e intenta de nuevo.");
  }
}

// Un archivo ya subido no se vuelve a subir: si el cliente reintenta tras un error (o le doble-
// clickea), reusamos su ejemploKey en vez de dejar un huérfano en el storage por intento. WeakMap
// porque la llave es el File mismo (se libera con él).
const clavesSubidas = new WeakMap<File, string>();

/** Sube el archivo de ejemplo (multipart, campo 'archivo') → ejemploKey. Lanza con mensaje de
 *  cliente si el gate lo rechaza, es ilegible o pesa de más. Idempotente por File. */
async function subirEjemploArchivo(org: string, file: File): Promise<string> {
  const yaSubida = clavesSubidas.get(file);
  if (yaSubida) return yaSubida;
  // Cota local ANTES de gastar la subida: el gate lo rechazaría igual, pero tras mandar los bytes.
  if (file.size > MAX_BYTES_EJEMPLO) {
    throw new Error(`Ese archivo pesa ${Math.round(file.size / 1024 / 1024)} MB; el máximo es 50 MB.`);
  }
  const form = new FormData();
  form.append("archivo", file);
  const r = await pedir(`/api/orgs/${org}/ejemplo`, { method: "POST", body: form });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    const msg =
      err.error === "entrada_rechazada" ? "Ese archivo no pasó la validación de seguridad."
      : err.error === "a_revision" ? "El archivo es ilegible; súbelo en otro formato (CSV, Excel…)."
      : err.error === "archivo_muy_grande" ? "El archivo es muy grande (máximo 50 MB)."
      : "No se pudo subir el archivo. Intenta con otro.";
    throw new Error(msg);
  }
  const d = (await r.json().catch(() => ({}))) as { ejemploKey?: string };
  if (!d.ejemploKey) throw new Error("No se pudo subir el archivo. Intenta con otro.");
  clavesSubidas.set(file, d.ejemploKey);
  return d.ejemploKey;
}

/** Cablea intake → build: sube el ejemplo y encola la construcción de la spec aprobada. Devuelve
 *  el id de la solicitud encolada (el cron de disparo crea la automatización).
 *
 *  El mapeo spec-del-intake → spec-del-build lo hace el adaptador CANÓNICO de core
 *  (intakeSpecABuildSpec), no una copia local: es el que sabe que al build viaja el criterio
 *  TÉCNICO (`criterio`, el que el Verifier puede ejecutar) y no el de cliente, y que las entradas
 *  conservan su tipo/formato reales (el planner los lee). */
export async function construirDesdeSpec(spec: SpecIntake, file: File): Promise<string> {
  const org = await orgActual();
  if (!org) throw new Error("No hay backend configurado (¿modo dev / login?).");
  // La cuota de espacios la cobra un trigger de la BD cuando el drainer crea la automatización —
  // DESPUÉS del request. Sin este chequeo, un cliente sin cupo vería "Manos a la obra" y nunca
  // recibiría nada. Es preventivo (no sustituye al trigger, que es la defensa real).
  const cuenta = await verCuenta();
  if (cuenta && cuenta.espaciosUsados >= cuenta.espaciosTotal) {
    throw new Error(
      `Tu plan ${cuenta.plan} llega hasta ${cuenta.espaciosTotal} automatizaciones y ya las tienes todas. Libera una o cambia de plan para construir otra.`,
    );
  }
  const ejemploKey = await subirEjemploArchivo(org, file);
  const cuerpo = { nombre: nombreDesdeObjetivo(spec.objetivo), ejemploKey, spec: intakeSpecABuildSpec(spec) };
  const r = await pedir(`/api/orgs/${org}/construir`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    // 400 = el cuerpo no pasó la validación: reintentar da exactamente lo mismo, así que no
    // invitamos a reintentar (eso mandaba al cliente a un bucle).
    const msg =
      err.error === "cuota_excedida" ? "Alcanzaste el límite de automatizaciones de tu plan."
      : err.error === "step_up_requerido" ? "Necesitas verificar tu identidad (MFA) para construir."
      : r.status === 400 ? "No pudimos armar el pedido con lo que entendimos. Corrige tus respuestas y vuelve a aprobar."
      : "No se pudo iniciar la construcción. Intenta de nuevo.";
    throw new Error(msg);
  }
  const d = (await r.json().catch(() => ({}))) as { id?: string };
  if (!d.id) throw new Error("No se pudo iniciar la construcción. Intenta de nuevo.");
  return d.id;
}

/** Baja el resultado de una corrida PASADA (GET /resultado). El Run ya lo guardaba en el storage,
 *  pero nadie lo leía de vuelta: el cliente corría su automatización, cerraba la pestaña, y su
 *  reporte quedaba inalcanzable. La clave del objeto la resuelve el backend bajo RLS — aquí solo
 *  viaja el id de la ejecución. Devuelve null si esa corrida no dejó resultado (p.ej. falló). */
export async function resultadoDeCorrida(ejecucionId: string): Promise<ResultadoDemo | null> {
  const org = await orgActual();
  if (!org) return null;
  const r = await pedir(`/api/orgs/${org}/resultado?ejecucionId=${encodeURIComponent(ejecucionId)}`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) return null;
  return (await r.json().catch(() => null)) as ResultadoDemo | null;
}

// ── Posventa: pedir un cambio / reportar una falla ───────────────────────────
// El CICLO de cada automatización, que cachea verAutomatizacion. La pantalla de ajustes lo necesita
// para decirle al cliente el COSTO REAL antes de que confirme: dentro de los primeros 30 días el
// cambio es gratis y no gasta ninguno de los 3.
export interface CicloVista {
  ajustesRestantes: number;
  ventanaGratis: boolean; // dentro de los 30 días post-entrega: el cambio NO gasta ajuste
  ventanaHasta: string | null;
  enRevision: boolean; // breaker de reparaciones enganchado
  congelada: boolean;
}
const cicloDe = new Map<string, CicloVista>();
export const cicloConocido = (id: string): CicloVista | undefined => cicloDe.get(id);

/** Pide un ajuste (POST /ajustar). Solo ENCOLA: la regresión (que decide si es cambio o reparación
 *  gratis) y el build los corre el cron. El backend EXIGE confirmado:true — el cliente tiene que
 *  haber visto el costo, así que esta función se llama sólo después de mostrárselo. */
export async function pedirAjuste(id: string, peticion: string): Promise<void> {
  const org = await orgActual();
  if (!org) throw new Error("No hay backend configurado.");
  const r = await pedir(`/api/orgs/${org}/ajustar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, peticion, confirmado: true }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    const msg =
      err.error === "cambio_en_curso" ? "Ya estamos preparando un cambio de esta automatización. Espera a que quede lista."
      : err.error === "inactiva" ? "Esta automatización quedó en solo lectura (tu plan bajó de nivel)."
      : err.error === "no_encontrada" ? "No encontramos esta automatización."
      : err.error === "step_up_requerido" ? "Necesitas verificar tu identidad (MFA)."
      : "No se pudo enviar el cambio. Intenta de nuevo.";
    throw new Error(msg);
  }
}

/** Hace definitiva (congela) una automatización. Lanza con mensaje de cliente si no se puede. */
export async function congelarAutomatizacion(id: string): Promise<void> {
  const org = await orgActual();
  if (!org) throw new Error("No hay backend configurado.");
  const r = await fetch(`/api/orgs/${org}/congelar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error === "no_se_puede_congelar" ? "No se puede: tiene un cambio en curso." : "No se pudo hacer definitiva.");
  }
}
