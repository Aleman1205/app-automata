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
