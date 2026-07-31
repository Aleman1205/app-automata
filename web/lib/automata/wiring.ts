import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { type Pool, type PoolClient } from "pg";
import { timingSafeEqual } from "node:crypto";
import { crearPool, crearPoolApp } from "automata-core/db/pg";
import { reaparBuildsColgados } from "automata-core/ciclo/servicio";
import { drenarCosecha, type CosechaDeps } from "automata-core/pipeline/cosecha";
import { drenarBuilds, type DisparoDeps } from "automata-core/pipeline/disparo";
import { drenarAjustes, type DrenarAjustesDeps } from "automata-core/pipeline/ajuste";
import { CmaBuildClient } from "automata-core/cma/build";
import { PlannerAgent } from "automata-core/planner/agent";
import { R2Storage, crearClienteR2 } from "automata-core/storage/r2";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { adaptar, adaptarUpload, type ConfigAdaptador } from "automata-core/http/adaptador";
import { gatearArchivoBytes, EntradaRechazada, EntradaEnRevision } from "automata-core/entrada/puente";
import { ejecutarAutomatizacion, SinVersionEjecutable } from "automata-core/pipeline/run";
import { LocalStorage } from "automata-core/storage/local";
import { LocalPythonExecutor } from "automata-core/run/executor";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { R } from "automata-core/http/tipos";
import { type Deps, type Endpoint } from "automata-core/http/pipeline";
import { type Sesion, type RateLimiter, type Solicitud, type Respuesta } from "automata-core/http/tipos";
import { plantillaCorreo, type Notificador, type EventoCorreo, type Correo } from "automata-core/ops/notificaciones";
import { MARCA } from "automata-core/marca";
import { orgsDeUsuario, provisionarUsuario } from "automata-core/ops/onboarding";
import { recibir, type Evento } from "automata-core/webhooks/receptor";
import { aplicarDowngrade } from "automata-core/billing/plan";
import Stripe from "stripe";
import { ServicioSuspendido } from "automata-core/ops/killswitch";
import { reverificationError } from "@clerk/nextjs/server";
import {
  iniciarCheckout, abrirPortalCliente, esPlanPagable,
  PagosNoConfigurados, SinSuscripcion, YaTieneSuscripcion, PasarelaCaida, type Pasarela,
} from "automata-core/billing/pasarela";
import { verificarStandardWebhook, verificarStripe, type Verificador } from "automata-core/webhooks/firma";
import { procesarCma, procesarStripe, type CambioPlan } from "automata-core/webhooks/handlers";
import { DEV, DEV_USER } from "./dev";

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
// mfaVerificadoEn (recencia del factor, para el step-up de acciones peligrosas) sale de las
// claims de Clerk vía mfaDesdeClaims(): `fva` (nativo, sin configurar nada) o el claim custom
// `mfaVerifiedAt` como respaldo. Sin ninguno → undefined → el step-up pide re-verificación
// (fail-safe). ⚠️ En DEV (doble-gated) la sesión es un usuario FIJO — bypass de Clerk;
// mfaVerificadoEn = ahora, así el step-up pasa en local. Fuera de DEV, Clerk real.
const sesion: Sesion = DEV
  ? { async autenticar() { return { userId: DEV_USER, mfaVerificadoEn: new Date() }; } }
  : {
      async autenticar() {
        const { userId, sessionClaims } = await auth();
        if (!userId) return null;
        return { userId, mfaVerificadoEn: mfaDesdeClaims(sessionClaims as Record<string, unknown> | null) };
      },
    };

// Recencia del factor de verificación desde las claims de Clerk, para el step-up (pipeline: MFA
// re-verificado hace ≤5 min). Clerk expone `fva` (factor verification age) en el token POR DEFECTO:
// [edad1erFactor, edad2oFactor] en MINUTOS desde la verificación, -1 si no aplica. Traducimos a un
// instante: si hay 2º factor (MFA) verificado usamos su edad; si no, la del 1er factor (una
// reautenticación reciente vale como step-up cuando el usuario aún no configura MFA). Respaldo: un
// claim custom `mfaVerifiedAt` (ISO/epoch) si se configura en el dashboard. Así invitar/quitar/
// facturación pasan tras un login o MFA reciente, en vez de dar 403 para siempre.
function mfaDesdeClaims(claims: Record<string, unknown> | null | undefined): Date | undefined {
  const fva = claims?.["fva"];
  if (Array.isArray(fva)) {
    const primero = typeof fva[0] === "number" ? fva[0] : -1;
    const segundo = typeof fva[1] === "number" ? fva[1] : -1;
    const edadMin = segundo >= 0 ? segundo : primero; // 2º factor (MFA) si existe; si no, el 1º
    if (edadMin >= 0) return new Date(Date.now() - edadMin * 60_000);
  }
  const raw = claims?.["mfaVerifiedAt"];
  if (typeof raw === "string" || typeof raw === "number") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

// ── Puerto 2: RateLimiter (Upstash), FAIL-CLOSED ──
// Contrato: si el store está caído, NEGAR (return false), nunca `return true`.
let rateInst: RateLimiter | undefined;
function getRate(): RateLimiter {
  if (rateInst) return rateInst;
  // ⚠️ En DEV (doble-gated): sin Upstash, permitir siempre (no hay abuso en local). Fuera de
  // DEV se exige Upstash (fail-closed real). Redis.fromEnv() leería UPSTASH_* → sin dev, sin app.
  if (DEV) return (rateInst = { async permitir() { return true; } });
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
    return conPistaDeReverificacion(await adaptar(ep, await getDeps(), getCfg())(req, orgId));
  };
}

/**
 * Traduce NUESTRO 403 de step-up a la PISTA que el front (Clerk) sabe leer, para que pueda abrir el
 * modal de re-verificación y reintentar solo. Sin esto el cliente se quedaba atorado: el claim `fva`
 * caduca a los 5 minutos y no había forma de refrescarlo sin cerrar sesión.
 *
 * Vive AQUÍ y no en core a propósito: `core` es framework- y vendor-agnóstico y no debe saber que
 * el proveedor de identidad es Clerk. Core dice "step_up_requerido"; el wiring lo traduce.
 *
 * El cuerpo lleva LAS DOS cosas: la pista de Clerk y nuestro `error`, porque el 403 también lo puede
 * leer un cliente que no es este front (o el propio front sin Clerk, en dev).
 *
 * `level: "first_factor"` NO es un detalle: nuestro pipeline acepta la edad del PRIMER factor
 * (`mfaDesdeClaims` cae a `fva[0]` cuando no hay segundo). Pedir "second_factor" abriría un modal
 * exigiendo un 2FA que muchos no tienen configurado — imposible de satisfacer.
 */
async function conPistaDeReverificacion(res: Response): Promise<Response> {
  if (res.status !== 403) return res;
  const cuerpo = (await res.clone().json().catch(() => null)) as { error?: string } | null;
  if (cuerpo?.error !== "step_up_requerido") return res;
  return Response.json(
    { ...reverificationError({ level: "first_factor", afterMinutes: 5 }), error: "step_up_requerido" },
    { status: 403 },
  );
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
  // El cambio de plan NO se aplica dentro de la tx del webhook: aplicarDowngrade corre con el pool
  // DUEÑO (es owner-only) y la tx del webhook ya tiene el lock de la fila de subscriptions — las dos
  // conexiones se abrazaban y el webhook se colgaba hasta el timeout con el cliente ya cobrado. El
  // handler DEVUELVE el cambio pendiente y se aplica aquí, después del commit.
  let pendiente: CambioPlan | undefined;
  const procesar =
    fuente === "cma"
      ? procesarCma
      : async (c: PoolClient, evento: Evento) => { pendiente = await procesarStripe(c, evento); };
  const r = await recibir({ rawBody, headers }, { verificador, fuente, pool: await getPoolWebhook() }, procesar);
  if (pendiente) {
    // Best-effort: el pago YA quedó registrado y el evento ya se dedupó, así que un fallo aquí no
    // debe devolverle un error a Stripe (reintentaría y el dedupe lo descartaría, dejando el plan sin
    // aplicar de todos modos). Se registra para que ops reconcilie.
    try {
      await aplicarDowngrade(getPoolOwner(), pendiente.org, pendiente.plan);
    } catch (e) {
      console.error(`[webhook:stripe] plan cobrado pero NO aplicado (org ${pendiente.org} → ${pendiente.plan}):`, e);
    }
  }
  // rechazado → 401 (firma) / 400 (JSON); ilegible/duplicado/aceptado → 200 (ack, corta reintentos).
  const status = r.estado === "rechazado" ? (r.motivo.startsWith("firma") ? 401 : 400) : 200;
  return new Response(JSON.stringify({ estado: r.estado }), { status, headers: { "content-type": "application/json" } });
}

const json = (status: number, cuerpo: unknown): Response =>
  new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

// ── Webhook de Clerk: ONBOARDING al registrarse (user.created → org + plan base + admin) ──
// Clerk firma con Svix, que ES standard-webhooks (mismo HMAC sobre `id.timestamp.body`, secreto
// whsec_): reusamos el verificador de CMA, solo remapeando sus cabeceras `svix-*` a `webhook-*`.
// En `user.created` provisiona la org del usuario nuevo (idempotente). Otros eventos → 200 no-op.
// NO pasa por `ruta`/withEfecto (camino de firma, como CMA); usa el pool de app + la SD acotada.
export async function webhookClerk(req: Request): Promise<Response> {
  const rawBody = await req.text(); // CRUDO — jamás req.json() (re-serializar rompe el MAC)
  const h = Object.fromEntries(req.headers);
  // Svix → standard-webhooks: mismas firmas, distinto prefijo de cabecera.
  const headers = {
    ...h,
    "webhook-id": h["svix-id"] ?? h["webhook-id"] ?? "",
    "webhook-timestamp": h["svix-timestamp"] ?? h["webhook-timestamp"] ?? "",
    "webhook-signature": h["svix-signature"] ?? h["webhook-signature"] ?? "",
  };
  const v = verificarStandardWebhook(rawBody, headers, env("CLERK_WEBHOOK_SECRET"), Date.now());
  if (!v.ok) return json(401, { error: "firma_invalida", motivo: v.motivo });
  let evt: {
    type?: string;
    data?: {
      id?: string;
      first_name?: string | null;
      last_name?: string | null;
      primary_email_address_id?: string | null;
      email_addresses?: { id?: string; email_address?: string; verification?: { status?: string } | null }[];
    };
  };
  try { evt = JSON.parse(rawBody); } catch { return json(400, { error: "json_invalido" }); }
  if (evt.type !== "user.created") return json(200, { estado: "ignorado", tipo: evt.type ?? null });
  const userId = evt.data?.id;
  if (!userId) return json(200, { estado: "sin_user_id" }); // ack para no reintentar en bucle
  const persona = [evt.data?.first_name, evt.data?.last_name].filter(Boolean).join(" ").trim();
  const nombre = persona ? `Negocio de ${persona}` : undefined;
  const { org, creada } = await provisionarUsuario(await getPool(), userId, nombre, correoVerificado(evt.data));
  return json(200, { estado: creada ? "provisionada" : "ya_existia", orgId: org.orgId });
}

// Correo VERIFICADO del payload de Clerk (el primario si está verificado; si no, el primero que lo
// esté). Sin verificar NO se devuelve: el correo decide si el usuario entra a un equipo que lo
// invitó, así que aceptar uno sin verificar dejaría que alguien se cuele poniendo el correo de otro
// al registrarse.
function correoVerificado(data?: {
  primary_email_address_id?: string | null;
  email_addresses?: { id?: string; email_address?: string; verification?: { status?: string } | null }[];
}): string | undefined {
  const lista = data?.email_addresses ?? [];
  const verificado = (e: (typeof lista)[number]) => e.verification?.status === "verified" && !!e.email_address;
  const primario = lista.find((e) => e.id === data?.primary_email_address_id);
  const elegido = primario && verificado(primario) ? primario : lista.find(verificado);
  return elegido?.email_address?.trim().toLowerCase();
}

// ── GET /api/yo: "¿en qué org estoy?" + onboarding perezoso ──────────────────
// Reemplaza la env clavada NEXT_PUBLIC_AUTOMATA_DEV_ORG: el front pega aquí para saber su org,
// resuelta desde la MEMBRESÍA del usuario autenticado. Si no tiene ninguna (usuario nuevo cuyo
// webhook no llegó, o preexistente), lo PROVISIONA al vuelo (idempotente). NO es org-scoped (aún
// no hay org → no puede pasar por el pipeline de /orgs/:orgId), así que trae su propia auth:
// rate-limit por IP + sesión de Clerk. Solo devuelve/crea orgs del PROPIO usuario (userId del JWT).
export async function misOrgs(req: Request): Promise<Response> {
  const ip = getCfg().ipDe(req) ?? "anon";
  if (!(await getRate().permitir(ip))) return json(429, { error: "demasiadas_peticiones" });
  const ident = await sesion.autenticar({ metodo: "GET" } as Solicitud);
  if (!ident) return json(401, { error: "no_autenticado" });
  const pool = await getPool();
  let orgs = await orgsDeUsuario(pool, ident.userId);
  // CANJEAR invitaciones aunque YA tenga org. app_aceptar_invitaciones solo se llamaba desde
  // app_provisionar_usuario, y esa función retorna ANTES si el usuario ya tiene cualquier
  // membresía — así que una invitación solo servía si la persona NUNCA se había registrado. El
  // caso común la rompía: alguien que ya usa Automata (o que se registró primero y fue invitado
  // después) no entraba nunca al equipo, y su lugar quedaba apartado sin que él lo supiera.
  // Es barato y idempotente: sin invitaciones para su correo no hace nada.
  if (orgs.length > 0) {
    const { correo } = await perfilClerk(ident.userId);
    if (correo) {
      const r = await pool.query<{ n: number }>("SELECT app_aceptar_invitaciones($1,$2) AS n", [ident.userId, correo]);
      if ((r.rows[0]?.n ?? 0) > 0) orgs = await orgsDeUsuario(pool, ident.userId); // entró a un equipo nuevo
    }
  }
  if (orgs.length === 0) {
    // Primer acceso sin org → onboarding al vuelo. Nombre y correo salen del perfil de Clerk; el
    // correo (solo si está VERIFICADO) es lo que puede meterlo al equipo que lo invitó en vez de
    // darle una org propia. Este es el camino que corre cuando el webhook no llegó.
    const perfil = await perfilClerk(ident.userId);
    await provisionarUsuario(pool, ident.userId, perfil.nombre, perfil.correo);
    orgs = await orgsDeUsuario(pool, ident.userId);
  }
  return json(200, { userId: ident.userId, orgs: orgs.map((o) => ({ id: o.orgId, rol: o.rol, nombre: o.nombre })) });
}

// Perfil del usuario en Clerk: nombre bonito para la org nueva + su correo VERIFICADO (el que puede
// canjear una invitación pendiente). En DEV no hay Clerk → ambos undefined → la SD usa 'Mi negocio'
// y no canjea nada. Best-effort: cualquier fallo → sin datos, el alta sigue.
async function perfilClerk(userId: string): Promise<{ nombre?: string; correo?: string }> {
  try {
    const clerk = await clerkClient();
    const u = await clerk.users.getUser(userId);
    const primario = u.primaryEmailAddress ?? u.emailAddresses[0];
    // Solo verificado: ver correoVerificado() — el correo abre la puerta a un equipo ajeno.
    const correo =
      primario?.verification?.status === "verified" ? primario.emailAddress?.trim().toLowerCase() : undefined;
    const persona = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    const base = primario?.emailAddress?.split("@")[0];
    return { nombre: persona ? `Negocio de ${persona}` : base ? `Negocio de ${base}` : undefined, correo };
  } catch {
    /* userId sin cuenta Clerk (dev/sembrado) o Clerk no disponible → sin datos */
    return {};
  }
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

// Storage del data-plane (mismo puerto `Storage`): R2 en producción; en DEV (doble-gated)
// LocalStorage sobre AUTOMATA_DEV_STORAGE_DIR — igual que el Run (correrAutomatizacion). Así el
// build (subida de ejemplo → disparo → cosecha) corre LOCAL sin credenciales de R2. Fuera de DEV
// nunca toca disco: getStorage() exige las R2_* (fail-closed).
function almacen() {
  if (DEV) {
    const dir = process.env.AUTOMATA_DEV_STORAGE_DIR;
    if (!dir) throw new Error("falta AUTOMATA_DEV_STORAGE_DIR (modo dev local)");
    return new LocalStorage(dir);
  }
  return getStorage();
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
// ── Notificaciones por correo (Resend) ──────────────────────────────────────
// Envía por la API REST de Resend (sin SDK). `from` = RESEND_FROM (o el remitente sandbox de
// Resend, que solo llega a tu propio correo hasta verificar un dominio). Lanza si Resend
// responde error; el llamador (cosecha) lo envuelve best-effort.
async function enviarResend(a: string[], correo: Correo): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || a.length === 0) return; // sin llave o sin destinatarios → no-op
  const from = process.env.RESEND_FROM ?? `${MARCA} <onboarding@resend.dev>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: a, subject: correo.asunto, text: correo.texto, html: correo.html }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// Correos de los ADMINS de una org: user_id (memberships) → email (Clerk). El perfil vive en
// Clerk, no en la BD; los usuarios sembrados a mano (sin cuenta Clerk) se saltan.
async function correosAdmins(orgId: string): Promise<string[]> {
  const admins = await getPoolOwner().query<{ user_id: string }>("SELECT user_id FROM memberships WHERE org_id = $1 AND rol = 'admin'", [orgId]);
  const clerk = await clerkClient();
  const correos: string[] = [];
  for (const { user_id } of admins.rows) {
    try {
      const u = await clerk.users.getUser(user_id);
      const email = u.primaryEmailAddress?.emailAddress ?? u.emailAddresses[0]?.emailAddress;
      if (email) correos.push(email);
    } catch {
      /* user_id sin cuenta Clerk (sembrado) → se salta */
    }
  }
  return correos;
}

// Notificador de producción: resuelve nombre + destinatarios (admins) y manda el correo del evento.
let notificadorInst: Notificador | undefined;
function getNotificador(): Notificador {
  return (notificadorInst ??= {
    async notificar(evento: EventoCorreo) {
      // LA INVITACIÓN VA APARTE: es el único aviso cuyo destinatario NO son los admins de la org,
      // sino alguien que todavía no tiene cuenta (por eso no hay a quién resolver por Clerk). Sale
      // primero para que no pueda caer por accidente en el camino de abajo y terminar avisándole al
      // que invita en vez de al invitado. El link va a /registrarse, que es público: mandarlo al
      // portafolio lo estrellaría contra el default-deny del middleware.
      if (evento.tipo === "invitacion") {
        if (!evento.destinatario) return; // sin a quién escribirle no se inventa un destinatario
        const o = await getPoolOwner().query<{ nombre: string }>("SELECT nombre FROM orgs WHERE id = $1", [evento.orgId]);
        await enviarResend([evento.destinatario], plantillaCorreo("invitacion", {
          nombre: o.rows[0]?.nombre ?? "tu equipo",
          url: `${env("APP_ORIGIN")}/registrarse`,
        }));
        return;
      }
      // Sin automatizacionId el aviso es de un build descartado antes de existir: el nombre viene
      // en el evento (de la solicitud encolada) y el link va al portafolio, no a un detalle que
      // no existe.
      let nombre = evento.nombre ?? "tu automatización";
      let url = `${env("APP_ORIGIN")}/portafolio`;
      if (evento.automatizacionId) {
        const a = await getPoolOwner().query<{ nombre: string }>("SELECT nombre FROM automatizaciones WHERE id = $1 AND org_id = $2", [evento.automatizacionId, evento.orgId]);
        nombre = a.rows[0]?.nombre ?? nombre;
        url = `${env("APP_ORIGIN")}/portafolio/${evento.automatizacionId}`;
      }
      await enviarResend(await correosAdmins(evento.orgId), plantillaCorreo(evento.tipo, { nombre, url }));
    },
  });
}

/**
 * Le avisa por correo a alguien que lo invitaron. BEST-EFFORT y SIEMPRE después de que la
 * invitación quedó guardada: si el correo falla, la invitación sigue siendo válida (la persona
 * entra al registrarse con ese correo) — al revés sí sería un problema, avisarle de algo que no
 * existe. Por eso nunca se lanza desde aquí.
 *
 * Se AWAITEA en vez de dispararlo y olvidarlo: en serverless la función se congela al responder y
 * un envío en vuelo se pierde en silencio, que es justo el bug que este correo venía a arreglar.
 */
export async function avisarInvitacion(orgId: string, correo: string): Promise<void> {
  try {
    await getNotificador().notificar({ tipo: "invitacion", orgId, destinatario: correo });
  } catch (e) {
    console.error(`[invitacion] no se pudo avisar a ${correo} (la invitación SÍ quedó):`, (e as { message?: string })?.message ?? e);
  }
}

/** Envío de PRUEBA (lo usa la ruta dev): manda un correo de muestra a `a` para confirmar que
 *  Resend + la plantilla funcionan, sin esperar a que corra un build. */
export async function enviarCorreoPrueba(a: string): Promise<void> {
  const base = process.env.APP_ORIGIN ?? "http://localhost:3000";
  await enviarResend([a], plantillaCorreo("lista", { nombre: "Reporte de prueba", url: `${base}/portafolio` }));
}

function getCosechaDeps(): CosechaDeps {
  return {
    pool: getPoolOwner(),
    cosechador: new CmaBuildClient(),
    storage: almacen(),
    notificador: getNotificador(), // avisa por correo al confirmar/fallar (best-effort)
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
    storage: almacen(),
    ahora: () => new Date().toISOString(),
    notificador: getNotificador(), // si el build se descarta tras 3 intentos, avisarle al cliente
  };
}

// ── Cron de AJUSTES: drena la cola que /ajustar encoló ──
// Corre con el pool de APP (el ciclo de vida vive bajo RLS), no con el dueño: a diferencia del
// disparo de builds, aquí no se crea ningún tenant.
async function getAjusteDeps(): Promise<DrenarAjustesDeps> {
  return {
    pool: await getPool(),
    poolOwner: getPoolOwner(), // la cola tiene REVOKE ALL para el app: reclamarla es del dueño
    // El planner también aquí, no solo en el disparo: la versión de un ajuste necesita SU vista
    // (la petición del cliente cambia la forma del resultado). Sin esto la v2 se entregaba sin
    // vista y reventaba al ejecutarla.
    planeador: new PlannerAgent(),
    cosechador: new CmaBuildClient(),
    storage: almacen(),
    ahora: () => new Date().toISOString(),
    notificador: getNotificador(), // si el ajuste se descarta tras 3 intentos, avisarle al cliente
  };
}

// ── Pasarela de pagos (Stripe): checkout + portal de cliente ──
// El SDK se construye EN CADA LLAMADA leyendo la env ahí mismo, no al importar: si se leyera arriba,
// `next build` y todo el modo dev tronarían por no tener llave de Stripe — el resto del wiring sigue
// esta misma regla. `apiVersion` NO se fija a propósito: el SDK usa la que le corresponde a su
// versión, y clavar una cadena aquí es la típica que se queda vieja y rompe en producción.
function pasarelaStripe(): Pasarela {
  const cliente = () => new Stripe(env("STRIPE_SECRET_KEY"), { maxNetworkRetries: 2, timeout: 10_000 });
  // Todo error del SDK se envuelve en PasarelaCaida. Crudo subiría como 500 'error_interno' y quien
  // intentó pagar se quedaría sin saber si le cobraron o no.
  const caida = (e: unknown): never => { throw new PasarelaCaida((e as { message?: string })?.message ?? String(e)); };
  const puerto: Pasarela = {
    async crearCheckout(a) {
      const s = await cliente().checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: a.priceId, quantity: 1 }],
        // client_reference_id es lo ÚNICO con que el webhook vincula el pago a una org
        // (`procesarStripe` → `app_stripe_vincular`). Sin esto Stripe cobra y el producto no se
        // entera: la org se queda en 'pendiente' y el cliente paga sin poder construir nada.
        client_reference_id: a.orgId,
        // Reusar el customer cuando ya existe evita duplicarlo en Stripe; app_stripe_vincular es
        // write-once y rechazaría un segundo customer para la misma org.
        ...(a.clienteId ? { customer: a.clienteId } : {}),
        success_url: a.exitoUrl,
        cancel_url: a.cancelUrl,
      }).catch(caida);
      if (!s.url) throw new PasarelaCaida("Stripe no devolvió URL de checkout");
      return s.url;
    },
    async abrirPortal(a) {
      const s = await cliente().billingPortal.sessions
        .create({ customer: a.clienteId, return_url: a.volverUrl })
        .catch(caida);
      return s.url;
    },
  };
  return puerto;
}

/** POST /api/orgs/:orgId/pagar — abre el checkout de Stripe para contratar un plan. Devuelve la URL
 *  a la que el front redirige. NO cambia el plan: eso lo hace el webhook cuando Stripe confirma. */
export async function crearCheckoutPago(req: Request, orgId: string): Promise<Response> {
  const handler = adaptarUpload(await getDeps(), getCfg(), { metodo: "POST", accion: "facturacion" }, async (r, org, cliente) => {
    const plan = ((await r.json().catch(() => ({}))) as { plan?: unknown }).plan;
    if (!esPlanPagable(plan)) return R.malParametro("plan debe ser base, pro o equipo");
    try {
      return R.ok(await iniciarCheckout(cliente, pasarelaStripe(), { orgId: org, plan, origen: getCfg().appOrigin }));
    } catch (e) {
      return errorDePago(e, "checkout");
    }
  });
  return conPistaDeReverificacion(await handler(req, orgId));
}

/** POST /api/orgs/:orgId/portal-pago — abre el portal de cliente de Stripe (tarjeta, facturas,
 *  cancelar). Solo si la org YA tiene suscripción; si no, lo que necesita es el checkout. */
export async function abrirPortalPago(req: Request, orgId: string): Promise<Response> {
  const handler = adaptarUpload(await getDeps(), getCfg(), { metodo: "POST", accion: "facturacion" }, async (_r, _org, cliente) => {
    try {
      return R.ok(await abrirPortalCliente(cliente, pasarelaStripe(), { origen: getCfg().appOrigin }));
    } catch (e) {
      return errorDePago(e, "portal");
    }
  });
  // Como el checkout: `facturacion` exige step-up, así que el 403 tiene que llevar la pista o el
  // cliente se queda sin poder tocar su propia suscripción.
  return conPistaDeReverificacion(await handler(req, orgId));
}

/** Traduce los fallos de cobro a algo accionable. Se distingue "no está configurado" de "Stripe
 *  falló": lo primero es un despliegue a medias (falta una env) y decirle "algo salió mal" a alguien
 *  que intentó pagar esconde justo el dato que arregla el problema. Nada de esto llega con detalle
 *  al cliente —podría traer identificadores de Stripe—, pero sí queda entero en el log. */
function errorDePago(e: unknown, donde: string): Respuesta {
  if (e instanceof SinSuscripcion) return { status: 409, cuerpo: { error: "sin_suscripcion" } };
  // El front lo usa para reencaminar al PORTAL, que es donde Stripe sí cambia de plan prorrateando.
  if (e instanceof YaTieneSuscripcion) return { status: 409, cuerpo: { error: "ya_tiene_suscripcion" } };
  if (e instanceof ServicioSuspendido) return { status: 503, cuerpo: { error: "cobros_suspendidos" } };
  if (e instanceof PagosNoConfigurados) {
    console.error(`[pagos] ${donde}: ${e.message} — falta configurar Stripe (envs STRIPE_*).`);
    return { status: 503, cuerpo: { error: "pagos_no_configurados" } };
  }
  console.error(`[pagos] ${donde} falló:`, (e as { message?: string })?.message ?? e);
  return { status: 502, cuerpo: { error: "pago_no_disponible" } };
}

/** Ruta de cron: drena ajuste_pendiente → regresión → arrancarAjuste (sesión de CMA para la
 *  versión siguiente). Auth por CRON_SECRET. */
export async function cronAjustes(req: Request): Promise<Response> {
  if (!autorizadoCron(req)) return new Response(JSON.stringify({ error: "no_autorizado" }), { status: 401, headers: { "content-type": "application/json" } });
  const r = await drenarAjustes(await getAjusteDeps());
  return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
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
    await almacen().put(key, bytes);
    return R.creado({ ejemploKey: key }); // el cliente la pasa a POST /construir
  });
  return handler(req, orgId);
}

// ── Ejecutar una automatización (el RUN real) ────────────────────────────────
// Camino sancionado APARTE (como subirEjemplo): pasa por las MISMAS 8 capas (autorizar, vía
// adaptarUpload) con acción "ejecutar", recibe multipart {automatizacionId, archivo}, y corre
// ejecutarAutomatizacion (core): freno → versión ejecutable (RLS) → reserva (cuota+kill) →
// LocalPythonExecutor → resolver la vista → confirmar. Devuelve el Resultado ya resuelto.
//
// SOLO funciona en DEV (LocalStorage + LocalPythonExecutor, local). En producción el Run va en
// el runner AISLADO (gVisor/CMA), no en un route serverless → 503 hasta desplegarlo.
export async function correrAutomatizacion(req: Request, orgId: string): Promise<Response> {
  const handler = adaptarUpload(await getDeps(), getCfg(), { metodo: "POST", accion: "ejecutar" }, async (r, org) => {
    if (!DEV) return { status: 503, cuerpo: { error: "runner_no_disponible", detalle: "El Run corre en el runner aislado (gVisor/CMA), no en serverless. Deferido." } };
    const len = Number(r.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > 55 * 1024 * 1024) return { status: 413, cuerpo: { error: "archivo_muy_grande" } };
    let bytes: Buffer;
    let nombre: string;
    let automatizacionId: string;
    try {
      const form = await r.formData();
      const archivo = form.get("archivo");
      const idRaw = form.get("automatizacionId");
      if (!(archivo instanceof File)) return R.malParametro("falta el archivo (campo 'archivo')");
      if (typeof idRaw !== "string" || !/^[0-9a-fA-F-]{36}$/.test(idRaw)) return R.malParametro("automatizacionId (uuid) requerido");
      automatizacionId = idRaw;
      nombre = archivo.name || "insumo.csv";
      bytes = Buffer.from(await archivo.arrayBuffer());
    } catch {
      return R.malParametro("cuerpo no es multipart válido");
    }
    const ext = path.extname(nombre).replace(/^\./, "").toLowerCase() || "csv";
    const storageDir = process.env.AUTOMATA_DEV_STORAGE_DIR;
    if (!storageDir) return { status: 500, cuerpo: { error: "falta AUTOMATA_DEV_STORAGE_DIR" } };
    // Materializa el insumo en un temp; el GATE de entrada lo valida dentro de ejecutarAutomatizacion.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "automata-run-in-"));
    const inputPath = path.join(dir, path.basename(nombre));
    const clave = path.basename(nombre);
    try {
      await fsp.writeFile(inputPath, bytes);
      const { resultado, ejecucion, ms } = await ejecutarAutomatizacion(
        { pool: await getPool(), storage: new LocalStorage(storageDir), run: new LocalPythonExecutor(), ahora: () => new Date().toISOString() },
        { orgId: org, automatizacionId, inputs: { [clave]: inputPath }, metas: { [clave]: { extension: ext } } },
      );
      return R.ok({ resultado, ejecucionId: ejecucion.id, ms });
    } catch (e) {
      if (e instanceof SinVersionEjecutable) return { status: 404, cuerpo: { error: "sin_version_ejecutable" } };
      if (e instanceof EntradaRechazada) return { status: 422, cuerpo: { error: "entrada_rechazada", motivo: e.motivo } };
      if (e instanceof EntradaEnRevision) return { status: 422, cuerpo: { error: "a_revision", nombre } };
      const err = e as { name?: string; message?: string };
      if (err.name === "CuotaExcedida" || /CUOTA_EXCEDIDA/.test(err.message ?? "")) return R.cuota(err.message ?? "cuota");
      if (err.name === "ServicioSuspendido" || /SUSPENDIDO/i.test(err.message ?? "")) return R.suspendido();
      // Un error NO reconocido sube al adaptador, que responde 500 `error_interno` sin cuerpo —
      // correcto de cara al cliente (no se filtran internals), pero deja a ops sin nada que mirar:
      // el Run es el paso donde el cliente espera SU resultado, y "algo salió mal" sin traza es
      // indiagnosticable. Se registra aquí antes de re-lanzar.
      console.error(`[ejecutar] error no manejado (org ${orgId}, automatización ${automatizacionId}):`, e);
      throw e;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  return handler(req, orgId);
}


// ── Descargar el resultado de una corrida PASADA ─────────────────────────────
// El Run ya guardaba el resultado en el storage (`resultados/<ejecucionId>.json`) y dejaba el
// puntero en `ejecuciones.resultado_key`, pero NADIE lo leía de vuelta: el cliente corría su
// automatización el lunes, cerraba la pestaña, y el martes su reporte era inalcanzable. El
// historial mostraba la corrida sin forma de recuperar lo que produjo.
//
// Camino sancionado aparte (como subirEjemplo/correrAutomatizacion): pasa por las MISMAS 8 capas
// vía adaptarUpload —que acepta el método, aquí GET— con acción "descargar" (admin y operador: el
// que ejecuta también baja lo que produjo). La clave se lee de la BD bajo RLS y NUNCA del query
// string: si viniera del cliente podría pedir el resultado de otra org.
export async function descargarResultado(req: Request, orgId: string): Promise<Response> {
  const handler = adaptarUpload(await getDeps(), getCfg(), { metodo: "GET", accion: "descargar" }, async (r, _org, cliente) => {
    const id = new URL(r.url).searchParams.get("ejecucionId") ?? "";
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return R.malParametro("ejecucionId (uuid) requerido");
    // RLS acota a la org: una ejecución ajena simplemente no existe para esta consulta.
    const q = await cliente.query<{ resultado_key: string | null }>(
      "SELECT resultado_key FROM ejecuciones WHERE id = $1",
      [id],
    );
    const key = q.rows[0]?.resultado_key;
    if (q.rows.length === 0) return { status: 404, cuerpo: { error: "no_encontrada" } };
    if (!key) return { status: 404, cuerpo: { error: "sin_resultado" } }; // corrida fallida o anterior a que se guardaran
    try {
      return { status: 200, cuerpo: JSON.parse(await almacen().getText(key)) as unknown };
    } catch {
      // El puntero existe pero el objeto no se pudo leer: no se finge un resultado vacío.
      return { status: 502, cuerpo: { error: "resultado_no_disponible" } };
    }
  });
  return handler(req, orgId);
}
