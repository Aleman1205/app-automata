import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
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
import { ejecutarAutomatizacion, SinVersionEjecutable } from "automata-core/pipeline/run";
import { LocalStorage } from "automata-core/storage/local";
import { LocalPythonExecutor } from "automata-core/run/executor";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { R } from "automata-core/http/tipos";
import { type Deps, type Endpoint } from "automata-core/http/pipeline";
import { type Sesion, type RateLimiter, type Solicitud } from "automata-core/http/tipos";
import { plantillaCorreo, type Notificador, type EventoCorreo, type Correo } from "automata-core/ops/notificaciones";
import { orgsDeUsuario, provisionarUsuario } from "automata-core/ops/onboarding";
import { recibir } from "automata-core/webhooks/receptor";
import { verificarStandardWebhook, verificarStripe, type Verificador } from "automata-core/webhooks/firma";
import { procesarCma, procesarStripe } from "automata-core/webhooks/handlers";
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
  const from = process.env.RESEND_FROM ?? "Automata <onboarding@resend.dev>";
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
      throw e;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  return handler(req, orgId);
}

