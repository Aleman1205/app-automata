import type { DatosTarjeta } from "@/app/portafolio/_componentes/tarjeta-automatizacion";
import type { EstadoAuto } from "@/lib/datos";

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
