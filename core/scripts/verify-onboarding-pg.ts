// ─────────────────────────────────────────────────────────────────────────────
// Verificación del ONBOARDING contra Postgres, por el camino REAL (rol de app llamando las SD
// app_orgs_de_usuario / app_provisionar_usuario). Confirma que: (1) un usuario NUEVO sin org se
// provisiona con org + subscription plan base + membresía admin; (2) es IDEMPOTENTE (2ª llamada
// no crea otra org ni otra membresía); (3) respeta el nombre dado (o 'Mi negocio' por defecto);
// (4) un usuario que YA tiene org no recibe otra; (5) altas CONCURRENTES del mismo user → UNA sola
// org (advisory lock); (6) la org creada queda usable bajo RLS (conOrg ve su propia membresía).
// Todo con el rol NO-dueño automata_app — prueba que las SD exponen el alta owner-only de forma acotada.
//   ADMIN_URL=... DATABASE_URL=... npm run verify:onboarding:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { orgsDeUsuario, provisionarUsuario } from "../src/ops/onboarding.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";

const U_NUEVO = "u_onb_nuevo";       // sin org → se provisiona
const U_NOMBRE = "u_onb_nombre";     // se provisiona con nombre explícito
const U_EXIST = "u_onb_existente";   // ya tiene una org sembrada
const U_CONC = "u_onb_concurrente";  // dos altas en paralelo
const U_INV = "user_onb_invitado";   // lo invitaron por correo ANTES de registrarse
const U_SOLO = "user_onb_sin_invit"; // mismo camino, pero a él nadie lo invitó
const CORREO_INV = "luis.invitado@vitrales.mx";
const SEED_ORG = "0dbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
const USERS = [U_NUEVO, U_NOMBRE, U_EXIST, U_CONC, U_INV, U_SOLO];

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  // Borra las orgs de estos usuarios (CASCADE limpia membresías/subs) + la org sembrada.
  const limpiar = async () => {
    await admin.query("DELETE FROM orgs WHERE id IN (SELECT org_id FROM memberships WHERE user_id = ANY($1))", [USERS]).catch(() => {});
    await admin.query("DELETE FROM orgs WHERE id = $1", [SEED_ORG]).catch(() => {});
  };
  try {
    await limpiar();

    console.log("1. Usuario NUEVO sin org → se provisiona (org + subscription base + admin):");
    const antes = await orgsDeUsuario(app, U_NUEVO);
    check("empieza sin ninguna org", antes.length === 0);
    const { org, creada } = await provisionarUsuario(app, U_NUEVO);
    check("creada = true (se dio de alta ahora)", creada === true);
    check("devuelve rol admin + un nombre", org.rol === "admin" && org.nombre.length > 0);
    const sub = await admin.query<{ plan: string; estado: string }>("SELECT plan, estado FROM subscriptions WHERE org_id = $1", [org.orgId]);
    check("subscription con plan 'base' y estado 'activa'", sub.rows[0]?.plan === "base" && sub.rows[0]?.estado === "activa");
    const mem = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND user_id = $2 AND rol = 'admin'", [org.orgId, U_NUEVO]);
    check("membresía admin del usuario en la org", mem.rows[0]?.n === 1);
    check("nombre por defecto = 'Mi negocio' (sin nombre dado)", org.nombre === "Mi negocio");

    console.log("\n2. IDEMPOTENCIA: 2ª llamada NO crea otra org ni otra membresía:");
    const r2 = await provisionarUsuario(app, U_NUEVO);
    check("misma org que la 1ª vez", r2.org.orgId === org.orgId);
    check("creada = false (ya existía)", r2.creada === false);
    const orgsU = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE user_id = $1", [U_NUEVO]);
    check("sigue con UNA sola membresía", orgsU.rows[0]?.n === 1);

    console.log("\n3. Respeta el NOMBRE dado:");
    const conNombre = await provisionarUsuario(app, U_NOMBRE, "Hotel Vitrales");
    check("org.nombre = 'Hotel Vitrales'", conNombre.org.nombre === "Hotel Vitrales");

    console.log("\n4. Usuario que YA tiene org (sembrada) → NO recibe otra:");
    await admin.query("INSERT INTO orgs (id, nombre) VALUES ($1, 'Org Sembrada')", [SEED_ORG]);
    await admin.query("INSERT INTO subscriptions (org_id, plan) VALUES ($1, 'pro')", [SEED_ORG]);
    await admin.query("INSERT INTO memberships (org_id, user_id, rol) VALUES ($1, $2, 'admin')", [SEED_ORG, U_EXIST]);
    const rExist = await provisionarUsuario(app, U_EXIST);
    check("devuelve la org sembrada (no crea otra)", rExist.org.orgId === SEED_ORG);
    check("creada = false", rExist.creada === false);
    const nExist = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE user_id = $1", [U_EXIST]);
    check("sigue con UNA sola membresía", nExist.rows[0]?.n === 1);

    console.log("\n5. CONCURRENCIA: dos altas en paralelo del mismo user → UNA sola org:");
    const [c1, c2] = await Promise.all([provisionarUsuario(app, U_CONC), provisionarUsuario(app, U_CONC)]);
    check("ambas llamadas devuelven la MISMA org", c1.org.orgId === c2.org.orgId);
    const nConc = await admin.query<{ n: number }>("SELECT count(DISTINCT org_id)::int AS n FROM memberships WHERE user_id = $1", [U_CONC]);
    check("existe UNA sola org para el usuario (no 2)", nConc.rows[0]?.n === 1);

    console.log("\n6. La org creada queda USABLE bajo RLS (conOrg ve su propia membresía):");
    const dentro = await conOrg(app, org.orgId, async (c) => {
      const m = await c.query<{ rol: string }>("SELECT rol FROM memberships WHERE user_id = $1", [U_NUEVO]);
      const otras = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE user_id = $1", [U_EXIST]); // de otra org
      return { rol: m.rows[0]?.rol, fugaCrossOrg: otras.rows[0]?.n ?? 0 };
    });
    check("bajo su org ve su membresía admin", dentro.rol === "admin");
    check("RLS aísla: NO ve membresías de otra org", dentro.fugaCrossOrg === 0);

    // El caso que estaba roto: a un invitado se le creaba su NEGOCIO PROPIO y la invitación quedaba
    // colgada, así que el portafolio compartido —el pitch del plan Equipo— era inalcanzable.
    console.log("\n7. INVITADO: se registra y entra al equipo que lo invitó (no a una org propia):");
    await conOrg(app, SEED_ORG, (c) =>
      c.query("INSERT INTO invitaciones (org_id, correo, rol) VALUES (app_current_org(), $1, 'operador')", [CORREO_INV]));
    check("la invitación quedó pendiente en la org que invita", (await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM invitaciones WHERE org_id = $1 AND correo = $2", [SEED_ORG, CORREO_INV])).rows[0]?.n === 1);
    const rInv = await provisionarUsuario(app, U_INV, "Negocio de Luis", CORREO_INV);
    check("aterriza en la org que lo invitó, NO en una nueva", rInv.org.orgId === SEED_ORG);
    check("con el rol que le dieron (operador, no admin)", rInv.org.rol === "operador");
    check("NO se le creó org propia", (await orgsDeUsuario(app, U_INV)).length === 1);
    check("la invitación se consumió (ya no ocupa lugar del plan)", (await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM invitaciones WHERE correo = $1", [CORREO_INV])).rows[0]?.n === 0);
    // Segunda llamada: no debe duplicar ni, ahora que ya es miembro, crearle una org aparte.
    const rInv2 = await provisionarUsuario(app, U_INV, undefined, CORREO_INV);
    check("2ª alta es idempotente (misma org)", rInv2.org.orgId === SEED_ORG);

    console.log("\n8. Un correo SIN invitación sigue recibiendo su propio negocio:");
    const rSolo = await provisionarUsuario(app, U_SOLO, undefined, "nadie-lo-invito@ejemplo.mx");
    check("se le crea org propia como admin", rSolo.org.rol === "admin" && rSolo.creada === true);
    check("no se colgó de la org ajena", rSolo.org.orgId !== SEED_ORG);
  } finally {
    await limpiar();
    await admin.end();
    await app.end();
  }
  console.log(`\n${ok ? "✓ ONBOARDING PROBADO" : "✗ FALLÓ"} — alta owner-only vía SD acotada por user: idempotente, plan base + admin, concurrencia-segura, RLS-aislada.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
