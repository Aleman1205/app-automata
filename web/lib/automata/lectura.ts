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
// que la UI ya sabe renderizar. Si no hay org configurada (prototipo sin backend) o el fetch
// falla, devuelve null → el llamador cae a los datos falsos de lib/datos (el prototipo sigue
// vivo). En modo dev local, NEXT_PUBLIC_AUTOMATA_DEV_ORG apunta a la org sembrada → datos reales.
// Cuando entre Clerk, la org saldrá de la sesión/organización activa en vez de esta env.
// ─────────────────────────────────────────────────────────────────────────────

const ORG = process.env.NEXT_PUBLIC_AUTOMATA_DEV_ORG;

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
  if (!ORG) return null;
  try {
    const r = await fetch(`/api/orgs/${ORG}/automatizaciones`, { headers: { accept: "application/json" }, cache: "no-store" });
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
  if (!ORG) return null;
  try {
    const r = await fetch(`/api/orgs/${ORG}/cuenta`, { headers: { accept: "application/json" }, cache: "no-store" });
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
  correo: string; // vacío hasta que Clerk aporte el perfil
  rol: "admin" | "operador";
  esTu: boolean;
}
const prettyUser = (userId: string): string => {
  const base = userId.replace(/^(u_|user_)/, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
};

export async function listarEquipo(): Promise<MiembroVista[] | null> {
  if (!ORG) return null;
  try {
    const r = await fetch(`/api/orgs/${ORG}/miembros`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json()) as { miembros: { userId: string; rol: "admin" | "operador"; esTu: boolean }[] };
    return d.miembros.map((m) => ({ id: m.userId, nombre: prettyUser(m.userId), correo: "", rol: m.rol, esTu: m.esTu }));
  } catch {
    return null;
  }
}

// ── Detalle de una automatización + ejecución real ───────────────────────────
// El endpoint de detalle da nombre/estado/versiones/conteo, pero NO el manifiesto ni el
// resultado (el manifiesto vive en el artefacto; el resultado nace de una corrida). Para el
// form usamos una entrada de archivo genérica (CSV) y el resultado llega del Run real.
export async function verAutomatizacion(id: string): Promise<Automatizacion | null> {
  if (!ORG) return null;
  try {
    const r = await fetch(`/api/orgs/${ORG}/automatizacion?id=${encodeURIComponent(id)}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      id: string; nombre: string; estado: EstadoAuto; creada: string | null; ejecuciones: number;
      ultimaEjecucion: string | null; ajustesUsados: number;
      versiones: { numero: number; tipo: string | null; creada: string | null }[];
    };
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
        { id: "archivo", tipo: "archivo", etiqueta: "Tu archivo de ventas", ayuda: "CSV con columnas: vendedor, monto", formatos: ["csv"] },
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
  if (!ORG) throw new Error("No hay backend configurado.");
  const form = new FormData();
  form.append("automatizacionId", automatizacionId);
  form.append("archivo", file);
  const r = await fetch(`/api/orgs/${ORG}/ejecutar`, { method: "POST", body: form });
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
  if (!ORG) return [];
  try {
    const r = await fetch(`/api/orgs/${ORG}/ejecuciones?id=${encodeURIComponent(automatizacionId)}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return [];
    const d = (await r.json()) as { ejecuciones: { id: string; estado: string; ms: number; creada: string | null }[] };
    return d.ejecuciones.map((e) => ({
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

/** Invita a un miembro (POST /miembros). En dev el step-up de MFA pasa (la sesión stub trae
 *  mfaVerificadoEn=ahora). Lanza con mensaje de cliente si la cuota/único-admin/etc. rechaza. */
export async function invitarMiembro(userId: string, rol: "admin" | "operador"): Promise<void> {
  if (!ORG) throw new Error("No hay backend configurado.");
  const r = await fetch(`/api/orgs/${ORG}/miembros`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, rol }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    const msg =
      err.error === "cuota_excedida" ? "Alcanzaste el límite de personas de tu plan."
      : err.error === "step_up_requerido" ? "Necesitas verificar tu identidad (MFA)."
      : "No se pudo invitar (¿ya está en el equipo?).";
    throw new Error(msg);
  }
}

/** Quita a un miembro (DELETE /miembros). El backend no deja la org sin admin (→ mensaje). */
export async function quitarMiembro(userId: string): Promise<void> {
  if (!ORG) throw new Error("No hay backend configurado.");
  const r = await fetch(`/api/orgs/${ORG}/miembros`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error === "no_puede_quedar_sin_admin" ? "No puedes quitar al único administrador." : "No se pudo quitar.");
  }
}

/** Hace definitiva (congela) una automatización. Lanza con mensaje de cliente si no se puede. */
export async function congelarAutomatizacion(id: string): Promise<void> {
  if (!ORG) throw new Error("No hay backend configurado.");
  const r = await fetch(`/api/orgs/${ORG}/congelar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error === "no_se_puede_congelar" ? "No se puede: tiene un cambio en curso." : "No se pudo hacer definitiva.");
  }
}
