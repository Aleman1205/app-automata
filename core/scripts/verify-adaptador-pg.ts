// ─────────────────────────────────────────────────────────────────────────────
// Verificación del adaptador HTTP (Request web → withEfecto → Response). Prueba la
// TRADUCCIÓN y las reglas del contrato (adaptador-next.md §4) con Request sintéticos y
// puertos fake, más un happy-path REAL contra Postgres (Request → adaptador → withEfecto
// → conOrg → handler → Response). withEfecto ya está probado a fondo en verify:http; aquí
// se prueba que el adaptador arma bien la Solicitud y traduce la Respuesta sin romper la
// seguridad (orgId de la ruta, hostEsperado siempre poblado, IP saneada, errores→500).
//   ADMIN_URL=... DATABASE_URL=... npm run verify:adaptador:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool } from "../src/db/pg.ts";
import { adaptar, type ConfigAdaptador } from "../src/http/adaptador.ts";
import { type Deps } from "../src/http/pipeline.ts";
import { crearAutomatizacionEP, ejecutarEP } from "../src/http/endpoints.ts";
import { congelar, descongelar } from "../src/ops/killswitch.ts";
import { type Identidad, type RateLimiter, type Sesion } from "../src/http/tipos.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOW = 1_000_000_000_000;
const ORIGEN = "https://app";

const IDS: Record<string, Identidad> = { tok_ana: { userId: "u_ana", mfaVerificadoEn: new Date(NOW - 60_000) } };
const sesion: Sesion = { async autenticar(s) { return s.sesionToken ? (IDS[s.sesionToken] ?? null) : null; } };
const rateSiempre: RateLimiter = { async permitir() { return true; } };
const rateNunca: RateLimiter = { async permitir() { return false; } };

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const cuerpoDe = (r: Response) => r.json() as Promise<{ error?: string; id?: string }>;

// Construye un Request web sintético (como el que Next entrega al route.ts).
function req(opts: { metodo?: string; origen?: string | null; cookie?: string; ip?: string; body?: unknown } = {}): Request {
  const h = new Headers();
  if (opts.origen !== null) h.set("origin", opts.origen ?? ORIGEN);
  if (opts.cookie) h.set("cookie", opts.cookie);
  if (opts.ip) h.set("x-real-ip", opts.ip);
  const metodo = opts.metodo ?? "POST";
  const init: RequestInit = { method: metodo, headers: h };
  if (metodo !== "GET" && metodo !== "HEAD") { init.body = JSON.stringify(opts.body ?? { nombre: "Reporte" }); h.set("content-type", "application/json"); }
  return new Request(`${ORIGEN}/api/orgs/${A}/automatizaciones`, init);
}

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const deps = (rate: RateLimiter = rateSiempre, ses: Sesion = sesion): Deps => ({ pool: app, sesion: ses, rate, ahora: () => NOW });
  const cfg: ConfigAdaptador = { appOrigin: ORIGEN, cookieSesion: "__session", ipDe: (r) => r.headers.get("x-real-ip") ?? undefined };
  const H = (d = deps(), c = cfg) => adaptar(crearAutomatizacionEP, d, c);

  try {
    await admin.query("DELETE FROM orgs WHERE id = $1", [A]);
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'A')", [A]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [A]);
    await admin.query("INSERT INTO memberships (org_id,user_id,rol) VALUES ($1,'u_ana','admin')", [A]);

    console.log("1. Config obligatoria: appOrigin (hostEsperado) sin él → falla al construir:");
    check("adaptar sin appOrigin lanza (no arranca mal configurado)", await (async () => { try { adaptar(crearAutomatizacionEP, deps(), { ...cfg, appOrigin: "" }); return false; } catch { return true; } })());

    console.log("\n2. Happy-path REAL contra Postgres (Request → adaptador → conOrg → handler):");
    const r1 = await H()(req({ cookie: "__session=tok_ana" }), A);
    check("POST válido → 2xx", r1.status >= 200 && r1.status < 300);
    check("la automatización se creó (existe en Postgres)", (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id=$1", [A])).rows[0]?.n === 1);
    check("respuesta es JSON con content-type", (r1.headers.get("content-type") ?? "").includes("application/json"));

    console.log("\n3. Traducción de la cookie de sesión:");
    check("sin cookie → sesionToken undefined → 401", (await H()(req({}), A)).status === 401);
    check("cookie __session entre varias → se extrae y autentica (2xx)", (await H()(req({ cookie: "otra=x; __session=tok_ana; y=1" }), A)).status >= 200 && (await H()(req({ cookie: "otra=x; __session=tok_ana; z=1" }), A)).status < 300);
    check("token desconocido → 401", (await H()(req({ cookie: "__session=tok_falso" }), A)).status === 401);

    console.log("\n4. orgId de la RUTA, nunca del cuerpo (anti IDOR):");
    check("orgId ausente (no lo pone la ruta) → 400, aunque el cuerpo traiga org_id", (await H()(req({ cookie: "__session=tok_ana", body: { nombre: "x", org_id: A } }), undefined)).status === 400);

    console.log("\n5. CSRF fail-closed (lo decide withEfecto; el adaptador solo pasa el Origin):");
    check("Origin ausente en POST → 403 csrf", (await cuerpoDe(await H()(req({ cookie: "__session=tok_ana", origen: null }), A))).error === "csrf_origen");
    check("Origin ajeno → 403 csrf", (await cuerpoDe(await H()(req({ cookie: "__session=tok_ana", origen: "https://evil" }), A))).error === "csrf_origen");

    console.log("\n6. Rate-limit y método:");
    check("rate agotado → 429", (await H(deps(rateNunca))(req({ cookie: "__session=tok_ana" }), A)).status === 429);
    check("método equivocado (GET a endpoint POST) → 405", (await H()(req({ metodo: "GET", cookie: "__session=tok_ana" }), A)).status === 405);
    const claves: string[] = [];
    await H(deps({ async permitir(k) { claves.push(k); return true; } }))(req({ cookie: "__session=tok_ana", ip: "9.9.9.9" }), A);
    check("la clave de rate es la IP saneada (x-real-ip vía cfg.ipDe)", claves[0] === "9.9.9.9");

    console.log("\n7. Errores INESPERADOS → 500 genérico, sin filtrar stack/mensaje:");
    const sesionRota: Sesion = { async autenticar() { throw new Error("SECRETO: cadena de conexión pg://user:pass@host"); } };
    const r500 = await H(deps(rateSiempre, sesionRota))(req({ cookie: "__session=tok_ana" }), A);
    const c500 = await cuerpoDe(r500);
    check("un throw inesperado → 500", r500.status === 500);
    check("el cuerpo NO filtra el mensaje/stack (solo 'error_interno')", c500.error === "error_interno" && !JSON.stringify(c500).includes("SECRETO"));

    console.log("\n8. Hallazgos de la revisión aplicados:");
    // cookie mal-formada (%XX inválido) → valor opaco → 401 (no 500, no corta antes de authn).
    const rCookie = await H()(req({ cookie: "__session=%" }), A);
    check("cookie mal-formada ('__session=%') → 401, NO 500", rCookie.status === 401);
    // headers seguros por defecto.
    check("respuesta trae Cache-Control: no-store y nosniff", r1.headers.get("cache-control") === "no-store" && r1.headers.get("x-content-type-options") === "nosniff");
    // llave de rate fail-closed: sin IP, cae a 'anon', NUNCA al token de cookie del atacante.
    const claves2: string[] = [];
    const cfgSinIp: ConfigAdaptador = { ...cfg, ipDe: () => undefined };
    await adaptar(crearAutomatizacionEP, deps({ async permitir(k) { claves2.push(k); return true; } }), cfgSinIp)(req({ cookie: "__session=ATACANTE_ELIGE" }), A);
    check("sin IP, la llave de rate es 'anon' (no el token de cookie elegido por el atacante)", claves2[0] === "anon");
    // ServicioSuspendido (kill-switch) → 503, no 500.
    await congelar(admin, "ejecuciones");
    const rSusp = await adaptar(ejecutarEP, deps(), cfg)(req({ cookie: "__session=tok_ana" }), A);
    await descongelar(admin, "ejecuciones");
    check("kill-switch (ejecuciones congeladas) por HTTP → 503, no 500", rSusp.status === 503);
    check("el 503 es genérico ('servicio_no_disponible')", (await cuerpoDe(rSusp)).error === "servicio_no_disponible");
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = $1", [A]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ ADAPTADOR PROBADO" : "✗ FALLÓ"} — Request→Solicitud→withEfecto→Response: orgId de la ruta, hostEsperado obligatorio, IP saneada, cookie parseada, errores→500 sin fugas.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
