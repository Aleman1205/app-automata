import { withEfecto, type Deps, type Endpoint } from "./pipeline.ts";
import { type Metodo, type Solicitud } from "./tipos.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Adaptador HTTP: convierte un Endpoint (+ Deps + config) en un handler de ruta web
// `(Request, orgId?) => Response`. Es la ÚNICA traducción entre el mundo web (Request/
// Response estándar, lo que usa Next 16) y el pipeline framework-agnóstico `withEfecto`.
// NINGUNA decisión de seguridad se toma aquí: solo se ARMAN los campos de la Solicitud
// respetando el contrato de adaptador-next.md §4, y `withEfecto` decide las 8 capas.
//
// El route.ts de Next queda en 2 líneas:
//   const POST = adaptar(crearAutomatizacionEP, deps, cfg);
//   export async function POST(req, { params }) { const { orgId } = await params; return POST(req, orgId); }
//
// Webhooks (CMA/Stripe) NO van por aquí: usan core/src/webhooks/ (cuerpo CRUDO + firma
// HMAC + conexión de dueño). Este adaptador es solo para endpoints con withEfecto.
// ─────────────────────────────────────────────────────────────────────────────

const MUTANTES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ConfigAdaptador {
  /** El origen propio (APP_ORIGIN) = hostEsperado del CSRF. OBLIGATORIO: sin él, el
   *  pipeline negaría toda mutación (fail-closed); el adaptador falla al construirse
   *  para que un despliegue mal configurado se caiga al arrancar, no en silencio. */
  appOrigin: string;
  /** Nombre de la cookie de sesión (Clerk: "__session"). httpOnly, nunca en la URL. */
  cookieSesion: string;
  /** IP YA SANEADA por el edge (IP de conexión / último hop de confianza), NO el
   *  X-Forwarded-For crudo (spoofable). La provee el wiring, que conoce la plataforma. */
  ipDe: (req: Request) => string | undefined;
}

/** Lee una cookie por nombre del header Cookie (sin dependencias). Un valor mal-formado
 *  (escape %XX inválido) se trata como opaco/ausente, NO revienta: `decodeURIComponent`
 *  lanza URIError con `__session=%`, y sin el guard eso sería un 500 que además cortaría
 *  antes del rate-limit (revisión adversarial). */
function leerCookie(req: Request, nombre: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const par of raw.split(";")) {
    const i = par.indexOf("=");
    if (i < 0) continue;
    if (par.slice(0, i).trim() !== nombre) continue;
    const val = par.slice(i + 1).trim();
    try { return decodeURIComponent(val); } catch { return val; } // ilegible → valor crudo
  }
  return undefined;
}

function jsonResponse(status: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Respuestas autenticadas por-usuario: nunca cacheables por un CDN/proxy compartido.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Envuelve un Endpoint en un handler de ruta web. El `orgId` llega por parámetro (de la
 * RUTA, nunca del cuerpo — anti IDOR/confused-deputy). Los errores INESPERADOS se
 * convierten en 500 genérico SIN stack ni mensaje (no filtrar; nunca caer a 200):
 * withEfecto ya tradujo NoAutorizado→403 y CuotaExcedida→402 a Respuesta, así que lo que
 * escapa hasta aquí es un bug o fallo de infraestructura.
 */
export function adaptar<T>(ep: Endpoint<T>, deps: Deps, cfg: ConfigAdaptador): (req: Request, orgId?: string) => Promise<Response> {
  if (!cfg.appOrigin) throw new Error("adaptar: falta appOrigin (hostEsperado). Sin él, el CSRF negaría toda mutación.");
  const correr = withEfecto(ep, deps);
  return async (req, orgId) => {
    try {
      // Normaliza el método: Web Request no pone en mayúsculas 'patch' (sí el resto), y
      // si no, un PATCH en minúscula no entraría a MUTANTES (no leería body ni exigiría
      // CSRF) y daría 405 espurio. NOTA de DoS: el cuerpo se materializa (req.json) ANTES
      // del rate-limit/authn de withEfecto; el edge DEBE capar tamaño/timeout del body
      // (la capa 0 no cubre la ingesta) — ver adaptador-next.md §4.
      const metodo = req.method.toUpperCase();
      const solicitud: Solicitud = {
        metodo: metodo as Metodo,
        orgId, // de la RUTA
        sesionToken: leerCookie(req, cfg.cookieSesion),
        origen: req.headers.get("origin") ?? undefined,
        hostEsperado: cfg.appOrigin, // SIEMPRE poblado
        ip: cfg.ipDe(req), // saneada por el edge
        // El cuerpo solo se lee (y consume el stream) en mutaciones; un GET no trae body.
        cuerpo: MUTANTES.has(metodo) ? await req.json().catch(() => undefined) : undefined,
      };
      const r = await correr(solicitud);
      return jsonResponse(r.status, r.cuerpo);
    } catch {
      return jsonResponse(500, { error: "error_interno" });
    }
  };
}
