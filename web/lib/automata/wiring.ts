import "server-only";
import { auth } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { type Pool } from "pg";
import { timingSafeEqual } from "node:crypto";
import { crearPool, crearPoolApp } from "automata-core/db/pg";
import { reaparBuildsColgados } from "automata-core/ciclo/servicio";
import { drenarCosecha, type CosechaDeps } from "automata-core/pipeline/cosecha";
import { drenarBuilds, type DisparoDeps } from "automata-core/pipeline/disparo";
import { CmaBuildClient } from "automata-core/cma/build";
import { PlannerAgent } from "automata-core/planner/agent";
import { R2Storage, crearClienteR2 } from "automata-core/storage/r2";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { adaptar, adaptarUpload, type ConfigAdaptador } from "automata-core/http/adaptador";
import { gatearArchivoBytes, EntradaRechazada, EntradaEnRevision } from "automata-core/entrada/puente";
import { R } from "automata-core/http/tipos";
import { type Deps, type Endpoint } from "automata-core/http/pipeline";
import { type Sesion, type RateLimiter } from "automata-core/http/tipos";
import { recibir } from "automata-core/webhooks/receptor";
import { verificarStandardWebhook, verificarStripe, type Verificador } from "automata-core/webhooks/firma";
import { procesarCma, procesarStripe } from "automata-core/webhooks/handlers";

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

// ── Webhooks (CMA / Stripe): OTRO camino — cuerpo CRUDO + firma HMAC ──
// Pool con el rol DEDICADO `automata_webhook` (no-super, no-dueño, sujeto a RLS): resuelve
// la org cross-org SOLO por los resolvers SECURITY DEFINER y luego opera bajo RLS con
// app.current_org. crearPoolApp lo AFIRMA seguro igual que el rol de app (afirmarRolSeguro
// acepta no-super/no-bypass/no-dueño). Antes se usaba el rol DUEÑO → los handlers eran
// no-op bajo FORCE RLS (hallazgo ALTA de la revisión).
let poolWebhookP: Promise<Pool> | undefined;
function getPoolWebhook(): Promise<Pool> {
  return (poolWebhookP ??= crearPoolApp(env("DATABASE_URL_WEBHOOK")));
}

/** Handler de ruta de webhook: verifica firma sobre el cuerpo CRUDO, deduplica y despacha
 *  el procesar correspondiente (todo en el receptor). El route.ts queda en 1 línea. */
export async function webhook(fuente: "cma" | "stripe", req: Request): Promise<Response> {
  const rawBody = await req.text(); // CRUDO — jamás req.json() (re-serializar rompe el MAC)
  const headers = Object.fromEntries(req.headers); // nombres en minúscula (Headers los normaliza)
  const verificador: Verificador =
    fuente === "cma"
      ? { verificar: (raw, h) => verificarStandardWebhook(raw, h, env("CMA_WEBHOOK_SECRET"), Date.now()) }
      : { verificar: (raw, h) => verificarStripe(raw, h["stripe-signature"] ?? "", env("STRIPE_WEBHOOK_SECRET"), Date.now()) };
  const procesar = fuente === "cma" ? procesarCma : procesarStripe;
  const r = await recibir({ rawBody, headers }, { verificador, fuente, pool: await getPoolWebhook() }, procesar);
  // rechazado → 401 (firma) / 400 (JSON); ilegible/duplicado/aceptado → 200 (ack, corta reintentos).
  const status = r.estado === "rechazado" ? (r.motivo.startsWith("firma") ? 401 : 400) : 200;
  return new Response(JSON.stringify({ estado: r.estado }), { status, headers: { "content-type": "application/json" } });
}

// ── Cron de ops (a2): reaper de builds colgados fuera del camino de request ──
// Pool con el rol DUEÑO (bypassa RLS): SOLO para tareas de ops (barrido cross-org). NO pasa
// por crearPoolApp — afirmarRolSeguro RECHAZA al dueño. Nunca alcanzable desde una ruta de
// request; su única defensa es CRON_SECRET. crearPool es síncrono (no afirma rol).
let poolOwner: Pool | undefined;
function getPoolOwner(): Pool {
  return (poolOwner ??= crearPool(env("DATABASE_URL_OWNER")));
}

// R2Storage lazy (reutilizado por cosecha, disparo y upload). No toca env al importar.
let storageInst: R2Storage | undefined;
function getStorage(): R2Storage {
  return (storageInst ??= new R2Storage(
    crearClienteR2({ accountId: env("R2_ACCOUNT_ID"), accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY"), bucket: env("R2_BUCKET") }),
    env("R2_BUCKET"),
  ));
}

// Comparación en tiempo constante del secreto del cron (Vercel Cron manda `Authorization:
// Bearer <CRON_SECRET>`). Fail-closed: longitudes distintas o header ausente → false.
function autorizadoCron(req: Request): boolean {
  const secreto = env("CRON_SECRET");
  const dado = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(dado);
  const b = Buffer.from(secreto);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Ruta de cron (Vercel Cron, cada 10 min): marca 'failed' los builds colgados y EMITE un
 *  incidente por cada uno (a2). Sin esto, un build cuyo webhook nunca llega queda 'building'
 *  para siempre. Corre con el pool DUEÑO. El route.ts queda en 1 línea. */
export async function cronReaper(req: Request): Promise<Response> {
  if (!autorizadoCron(req)) return new Response(JSON.stringify({ error: "no_autorizado" }), { status: 401, headers: { "content-type": "application/json" } });
  const reapeados = await reaparBuildsColgados(getPoolOwner());
  return new Response(JSON.stringify({ reapeados }), { status: 200, headers: { "content-type": "application/json" } });
}

// ── Cron de cosecha (a3): drena el outbox → cosecha en CMA → sube a R2 → confirma ──
// Deps LAZY (no tocan env al importar): CmaBuildClient (ANTHROPIC_API_KEY) + R2Storage se
// construyen al invocar, para que `next build` no falle sin credenciales.
function getCosechaDeps(): CosechaDeps {
  return {
    pool: getPoolOwner(),
    cosechador: new CmaBuildClient(),
    storage: getStorage(),
  };
}

/** Ruta de cron (Vercel Cron): drena el outbox de cosecha. Cierra el loop async del build
 *  (webhook encoló → aquí se cosecha). Auth por CRON_SECRET; corre con el pool DUEÑO. */
export async function cronCosecha(req: Request): Promise<Response> {
  if (!autorizadoCron(req)) return new Response(JSON.stringify({ error: "no_autorizado" }), { status: 401, headers: { "content-type": "application/json" } });
  const r = await drenarCosecha(getCosechaDeps());
  return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
}

// ── Cron de disparo (a3-s6): drena build_pendiente → planner → arrancarConstruccion ──
function getDisparoDeps(): DisparoDeps {
  return {
    pool: getPoolOwner(),
    planeador: new PlannerAgent(),
    cosechador: new CmaBuildClient(),
    storage: getStorage(),
    ahora: () => new Date().toISOString(),
  };
}

/** Ruta de cron: drena las solicitudes de build encoladas por /construir → corre el planner y
 *  arranca el build en CMA. Auth por CRON_SECRET; corre con el pool DUEÑO. */
export async function cronDisparo(req: Request): Promise<Response> {
  if (!autorizadoCron(req)) return new Response(JSON.stringify({ error: "no_autorizado" }), { status: 401, headers: { "content-type": "application/json" } });
  const r = await drenarBuilds(getDisparoDeps());
  return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
}

// ── Subida de ejemplos a R2 (a3-s6 / upload binario) ──
// Camino sancionado APARTE del pipeline JSON: pasa por las MISMAS 8 capas (autorizar, vía
// adaptarUpload) pero con cuerpo multipart. Valida el archivo con el GATE (a4) ANTES de
// guardarlo (nunca se almacenan bytes hostiles) y lo sube a una clave org-scopeada que
// POST /construir consume. El cliente sube el archivo, recibe la ejemploKey, y la manda a construir.
export async function subirEjemplo(req: Request, orgId: string): Promise<Response> {
  const handler = adaptarUpload(await getDeps(), getCfg(), { metodo: "POST", accion: "crear_build" }, async (r, org) => {
    // Cota temprana por Content-Length ANTES de materializar el archivo en RAM (anti-DoS).
    const len = Number(r.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > 55 * 1024 * 1024) return { status: 413, cuerpo: { error: "archivo_muy_grande" } };
    let bytes: Buffer;
    let nombre: string;
    try {
      const form = await r.formData();
      const archivo = form.get("archivo");
      if (!(archivo instanceof File)) return R.malParametro("falta el archivo (campo 'archivo')");
      nombre = archivo.name || "ejemplo";
      bytes = Buffer.from(await archivo.arrayBuffer());
    } catch {
      return R.malParametro("cuerpo no es multipart válido");
    }
    const ext = path.extname(nombre).replace(/^\./, "").toLowerCase();
    try {
      gatearArchivoBytes(nombre, ext, bytes); // GATE: hostil → EntradaRechazada; ilegible → EnRevision
    } catch (e) {
      if (e instanceof EntradaRechazada) return { status: 422, cuerpo: { error: "entrada_rechazada", motivo: e.motivo } };
      if (e instanceof EntradaEnRevision) return { status: 422, cuerpo: { error: "a_revision", nombre } };
      throw e;
    }
    const key = `ejemplos/${org}/${randomUUID()}.${ext}`;
    await getStorage().put(key, bytes);
    return R.creado({ ejemploKey: key }); // el cliente la pasa a POST /construir
  });
  return handler(req, orgId);
}

