// ─────────────────────────────────────────────────────────────────────────────
// Verificación del pipeline HTTP (el "wrapping", docs/13 §3) contra Postgres real,
// con puertos FAKE para Clerk (sesión) y el rate-limit. Prueba las 8 capas end-to-end,
// el IDOR cross-org por HTTP, y los fail-closed que cazó la revisión adversarial
// (CSRF sin Origin, método, step-up con timestamp futuro, invitar-admin exige MFA,
// no dejar la org sin admin).
//   ADMIN_URL=... DATABASE_URL=... npm run verify:http   (defaults: cluster temporal)
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool } from "../src/db/pg.ts";
import { withEfecto, type Deps } from "../src/http/pipeline.ts";
import { crearAutomatizacionEP, invitarEP, quitarMiembroEP, ejecutarEP, ENDPOINTS } from "../src/http/endpoints.ts";
import { type Identidad, type RateLimiter, type Sesion, type Solicitud } from "../src/http/tipos.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // equipo
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // equipo (para IDOR)
const Q = "99999999-9999-9999-9999-999999999999"; // base (cuota→402 y único-admin)
const NOW = 1_000_000_000_000;

const IDS: Record<string, Identidad> = {
  tok_ana: { userId: "u_ana", mfaVerificadoEn: new Date(NOW - 60_000) }, // admin, MFA fresco
  tok_ana_stale: { userId: "u_ana" }, // admin, sin MFA reciente
  tok_ana_futuro: { userId: "u_ana", mfaVerificadoEn: new Date(NOW + 60_000) }, // MFA en el futuro (inválido)
  tok_luis: { userId: "u_luis" }, // operador
  tok_intruso: { userId: "u_intruso" }, // no es miembro de A/B/Q
};
const sesion: Sesion = { async autenticar(s) { return s.sesionToken ? (IDS[s.sesionToken] ?? null) : null; } };
const rateSiempre: RateLimiter = { async permitir() { return true; } };
const rateNunca: RateLimiter = { async permitir() { return false; } };

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const err = (r: { cuerpo: unknown }) => (r.cuerpo as { error?: string }).error;

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const deps = (rate: RateLimiter = rateSiempre): Deps => ({ pool: app, sesion, rate, ahora: () => NOW });
  const req = (over: Partial<Solicitud>): Solicitud => ({
    metodo: "POST", orgId: A, sesionToken: "tok_ana", origen: "https://app", hostEsperado: "https://app",
    ip: "1.1.1.1", cuerpo: {}, ...over,
  });
  const crear = (over: Partial<Solicitud>, d = deps()) => withEfecto(crearAutomatizacionEP, d)(req(over));
  const ejecutar = (over: Partial<Solicitud>) => withEfecto(ejecutarEP, deps())(req(over));
  const invitar = (over: Partial<Solicitud>) => withEfecto(invitarEP, deps())(req(over));
  const quitar = (over: Partial<Solicitud>) => withEfecto(quitarMiembroEP, deps())(req({ metodo: "DELETE", ...over }));

  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B, Q]]);
    for (const [id, plan] of [[A, "equipo"], [B, "equipo"], [Q, "base"]] as const) {
      await admin.query("INSERT INTO orgs (id, nombre) VALUES ($1,$2)", [id, id.slice(0, 4)]);
      await admin.query("INSERT INTO subscriptions (org_id, plan) VALUES ($1,$2)", [id, plan]);
    }
    await admin.query("INSERT INTO memberships (org_id,user_id,rol) VALUES ($1,'u_ana','admin'),($1,'u_luis','operador'),($1,'u_temp','operador')", [A]);
    await admin.query("INSERT INTO memberships (org_id,user_id,rol) VALUES ($1,'u_otro','admin')", [B]);
    await admin.query("INSERT INTO memberships (org_id,user_id,rol) VALUES ($1,'u_ana','admin')", [Q]);

    console.log("1. Capas 0-2 (rate / authn / CSRF / método), fail-closed:");
    check("sin sesión → 401", (await crear({ sesionToken: undefined })).status === 401);
    check("rate-limit agotado → 429", (await crear({}, deps(rateNunca))).status === 429);
    check("CSRF: origen ajeno → 403", err(await crear({ origen: "https://evil" })) === "csrf_origen");
    check("CSRF: Origin AUSENTE en mutación → 403 (fail-closed)", err(await crear({ origen: undefined })) === "csrf_origen");
    check("CSRF: hostEsperado sin configurar → 403 (no se apaga la capa)", err(await crear({ hostEsperado: undefined })) === "csrf_origen");
    check("método equivocado (GET a endpoint POST) → 405", (await crear({ metodo: "GET" })).status === 405);
    // La clave de rate es la IP saneada.
    const claves: string[] = [];
    await crear({ ip: "9.9.9.9" }, deps({ async permitir(k) { claves.push(k); return true; } }));
    check("rate-limit se llavea por la IP saneada", claves[0] === "9.9.9.9");

    console.log("\n2. Capas 4 (validación) y 7 (rol):");
    check("cuerpo sin 'nombre' → 400", (await crear({ cuerpo: {} })).status === 400);
    const c1 = await crear({ cuerpo: { nombre: "Reporte" } });
    check("admin crea → 201 con id", c1.status === 201 && typeof (c1.cuerpo as { id?: string }).id === "string");
    check("operador NO puede crear → 403", (await crear({ sesionToken: "tok_luis", cuerpo: { nombre: "x" } })).status === 403);
    check("operador SÍ puede ejecutar → 200", (await ejecutar({ sesionToken: "tok_luis" })).status === 200);

    console.log("\n3. Capa 5 (step-up MFA), doble cota:");
    check("quitar sin MFA reciente → 403 step_up", err(await quitar({ sesionToken: "tok_ana_stale", cuerpo: { userId: "u_temp" } })) === "step_up_requerido");
    check("quitar con MFA en el FUTURO → 403 step_up (no evade)", err(await quitar({ sesionToken: "tok_ana_futuro", cuerpo: { userId: "u_temp" } })) === "step_up_requerido");
    check("quitar con MFA fresco → 200", (await quitar({ sesionToken: "tok_ana", cuerpo: { userId: "u_temp" } })).status === 200);
    check("invitar SIN MFA (invitar ahora es peligrosa) → 403 step_up", err(await invitar({ sesionToken: "tok_ana_stale", cuerpo: { userId: "u_nuevo", rol: "operador" } })) === "step_up_requerido");
    check("invitar con MFA fresco → 201", (await invitar({ cuerpo: { userId: "u_nuevo", rol: "operador" } })).status === 201);
    check("operador NO puede invitar → 403", (await invitar({ sesionToken: "tok_luis", cuerpo: { userId: "z", rol: "operador" } })).status === 403);
    check("invitar con rol inválido → 400", (await invitar({ cuerpo: { userId: "z", rol: "root" } })).status === 400);

    console.log("\n4. Capa 6-7 (membresía viva) — IDOR cross-org por HTTP:");
    check("admin de A que pega a la org B → 403 (no es miembro de B)", (await crear({ orgId: B, cuerpo: { nombre: "robo" } })).status === 403);
    check("intruso (sin membresía en A) → 403", (await crear({ sesionToken: "tok_intruso", cuerpo: { nombre: "x" } })).status === 403);

    console.log("\n5. CuotaExcedida → 402 (plan base, 3 espacios):");
    for (let i = 0; i < 3; i++) await crear({ orgId: Q, cuerpo: { nombre: `q${i}` } });
    check("la 4ª creación en plan base → 402", err(await crear({ orgId: Q, cuerpo: { nombre: "q4" } })) === "cuota_excedida");

    console.log("\n6. quitarMiembro: no dejar la org sin admin, y no-miembro:");
    check("quitar al ÚNICO admin de la org → 403 no_puede_quedar_sin_admin", err(await quitar({ orgId: Q, cuerpo: { userId: "u_ana" } })) === "no_puede_quedar_sin_admin");
    check("quitar a un no-miembro → 400", (await quitar({ cuerpo: { userId: "u_fantasma" } })).status === 400);

    console.log("\n7. Cobertura de registro:");
    const acciones = new Set(["ver", "crear_build", "invitar", "quitar_gente", "ejecutar", "descargar", "ajustar", "facturacion", "exportar_codigo", "gestionar_espacios", "borrar_org"]);
    check("todo endpoint declara método + acción válida", ENDPOINTS.every((e) => acciones.has(e.accion) && !!e.metodo));
    check("los 12 endpoints están registrados (7 con efecto + 5 de lectura)", ENDPOINTS.length === 12 && ENDPOINTS.includes(invitarEP));
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B, Q]]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ WRAPPING (pipeline HTTP de 8 capas) PROBADO" : "✗ FALLÓ"} — CSRF/rol/step-up/cuota/IDOR fail-closed por HTTP.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
