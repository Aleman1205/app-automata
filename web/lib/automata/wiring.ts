import "server-only";
import { auth } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { type Pool } from "pg";
import { crearPoolApp } from "automata-core/db/pg";
import { adaptar, type ConfigAdaptador } from "automata-core/http/adaptador";
import { type Deps, type Endpoint } from "automata-core/http/pipeline";
import { type Sesion, type RateLimiter } from "automata-core/http/tipos";

// ─────────────────────────────────────────────────────────────────────────────
// Cableado del pipeline HTTP a servicios reales (el contrato de adaptador-next.md).
// AQUÍ no se decide nada de seguridad: solo se implementan los 3 puertos con Clerk /
// Upstash / Neon y se ensamblan Deps + Config para adaptar(). Todo LAZY: nada toca env
// al importar, así `next build` no se cae si faltan las variables — fallan en la 1ª
// request con un error accionable. `server-only` evita filtrar esto a un bundle cliente.
// ─────────────────────────────────────────────────────────────────────────────

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Falta la variable de entorno ${k} (ver web/.env.example)`);
  return v;
}

// ── Puerto 1: Sesión (Clerk verifica el JWT en el SERVIDOR: issuer + JWKS) ──
// Ignora `s`: usa el contexto ambiental del request (headers/cookies) que Clerk lee.
// mfaVerificadoEn sale de un claim de sesión — configurar en Clerk (session token) que
// exponga `mfaVerifiedAt`; sin él, el step-up siempre pedirá re-verificación (fail-safe).
const sesion: Sesion = {
  async autenticar() {
    const { userId, sessionClaims } = await auth();
    if (!userId) return null;
    const raw = (sessionClaims as Record<string, unknown> | null)?.["mfaVerifiedAt"];
    const mfa = typeof raw === "string" || typeof raw === "number" ? new Date(raw) : undefined;
    return { userId, mfaVerificadoEn: mfa && !Number.isNaN(mfa.getTime()) ? mfa : undefined };
  },
};

// ── Puerto 2: RateLimiter (Upstash), FAIL-CLOSED ──
// Contrato: si el store está caído, NEGAR (return false), nunca `return true`.
let rateInst: RateLimiter | undefined;
function getRate(): RateLimiter {
  if (rateInst) return rateInst;
  const rl = new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(30, "10 s"), analytics: false });
  rateInst = {
    async permitir(clave) {
      try {
        return (await rl.limit(clave)).success;
      } catch {
        return false; // store caído → negar (fail-closed)
      }
    },
  };
  return rateInst;
}

// ── Puerto 3: pool de Neon (rol NO-dueño automata_app) ──
// crearPoolApp AFIRMA el rol seguro al abrir (superuser/BYPASSRLS/dueño → falla al arrancar).
let poolP: Promise<Pool> | undefined;
function getPool(): Promise<Pool> {
  return (poolP ??= crearPoolApp(env("DATABASE_URL")));
}

async function getDeps(): Promise<Deps> {
  return { pool: await getPool(), sesion, rate: getRate() };
}

// ── Config del adaptador ──
// appOrigin OBLIGATORIO (sin él adaptar() lanza; el CSRF negaría toda mutación).
let cfgInst: ConfigAdaptador | undefined;
function getCfg(): ConfigAdaptador {
  return (cfgInst ??= {
    appOrigin: env("APP_ORIGIN"), // p.ej. https://automata.mx (SIN slash final)
    cookieSesion: "__session", // cookie de sesión de Clerk
    // IP saneada por el edge. En Vercel, x-forwarded-for viene con la IP de conexión
    // como primer hop (Vercel la reescribe); x-real-ip es el fallback.
    ipDe: (req) =>
      req.headers.get("x-real-ip") ??
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      undefined,
  });
}

// ── El ÚNICO camino sancionado: envuelve un Endpoint en un handler de ruta de Next ──
// El route.ts queda en: `export const POST = ruta(crearAutomatizacionEP)`. El test
// anti-olvido (core: verify:rutas) FALLA si un verbo mutante no pasa por `ruta`.
type CtxRuta = { params: Promise<Record<string, string>> };
export function ruta<T>(ep: Endpoint<T>): (req: Request, ctx: CtxRuta) => Promise<Response> {
  return async (req, ctx) => {
    const { orgId } = await ctx.params; // orgId de la RUTA (nunca del cuerpo)
    return adaptar(ep, await getDeps(), getCfg())(req, orgId);
  };
}

