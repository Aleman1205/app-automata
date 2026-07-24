// ─────────────────────────────────────────────────────────────────────────────
// Verificación del aislamiento por el CAMINO DE CÓDIGO real (Node → pg → RLS).
// La app se conecta con el rol NO-DUEÑO automata_app (NOSUPERUSER, NOBYPASSRLS) —
// docs/11 §6. Se siembra con una conexión superusuaria aparte (ADMIN_URL); TODO lo
// que la app hace corre sobre el pool de automata_app, así que RLS aplica de verdad
// (incluso FUERA de conOrg: fail-closed). Necesita el schema aplicado.
//
//   ADMIN_URL=postgres://postgres@host/db  DATABASE_URL=postgres://automata_app@host/db  npm run verify:pg
//   (por defecto apuntan al cluster temporal en 127.0.0.1:55432)
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg, afirmarRolSeguro } from "../src/db/pg.ts";
import { leerMembresia } from "../src/auth/membresia.ts";
import { assertCan, NoAutorizado, type Membresia } from "../src/auth/roles.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const A1 = "a0000000-0000-0000-0000-000000000001";
const B1 = "b0000000-0000-0000-0000-000000000001";

let ok = true;
const check = (nombre: string, paso: boolean) => {
  console.log(`  ${paso ? "✓" : "✗"} ${nombre}`);
  ok = ok && paso;
};
const permite = (fn: () => void) => {
  try { fn(); return true; } catch { return false; }
};
const deniega = (fn: () => void) => {
  try { fn(); return false; } catch (e) { return e instanceof NoAutorizado; }
};

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  try {
    // Semilla como superusuario (RLS bypassed): 2 orgs, 2 membresías, 2 automatizaciones.
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]);
    await admin.query("INSERT INTO orgs (id, nombre) VALUES ($1,'M2 A'), ($2,'M2 B')", [A, B]);
    await admin.query(
      "INSERT INTO memberships (org_id, user_id, rol) VALUES ($1,'u_ana','admin'), ($2,'u_beto','admin')",
      [A, B],
    );
    await admin.query(
      "INSERT INTO automatizaciones (id, org_id, nombre) VALUES ($1,$2,'A1'), ($3,$4,'B1')",
      [A1, A, B1, B],
    );

    console.log("0. El rol de la app es seguro (docs/11 §6):");
    let guardOk = true;
    try { await afirmarRolSeguro(app); } catch { guardOk = false; }
    check("el rol de conexión NO es superuser ni bypassrls", guardOk);

    console.log("\n1. RLS NO es inerte (el hueco que cazó la revisión de M2):");
    const fuera = await app.query("SELECT count(*)::int AS n FROM automatizaciones");
    check("query directa SIN conOrg ve 0 filas (fail-closed, RLS aplica sobre el pool)", fuera.rows[0].n === 0);

    console.log("\n2. conOrg() aísla por org:");
    const nA = await conOrg(app, A, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM automatizaciones");
      return r.rows[0].n as number;
    });
    check("conOrg(A) ve solo su automatización (1)", nA === 1);

    const nAsobreB = await conOrg(app, A, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id = $1", [B]);
      return r.rows[0].n as number;
    });
    check("conOrg(A) NO ve nada de B ni pidiéndolo por org_id (cross-tenant)", nAsobreB === 0);

    const nB = await conOrg(app, B, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM automatizaciones");
      return r.rows[0].n as number;
    });
    check("conOrg(B) ve solo la suya (1), no la de A", nB === 1);

    console.log("\n3. Escrituras cross-org bloqueadas:");
    let insBloqueado = false;
    try {
      await conOrg(app, B, async (c) => {
        await c.query("INSERT INTO automatizaciones (org_id, nombre) VALUES ($1, 'intruso')", [A]);
      });
    } catch { insBloqueado = true; }
    check("conOrg(B) NO puede INSERTAR en la org A (WITH CHECK)", insBloqueado);

    const upd = await conOrg(app, A, async (c) => {
      const r = await c.query("UPDATE automatizaciones SET nombre = 'secuestrada' WHERE org_id = $1", [B]);
      return r.rowCount ?? 0;
    });
    check("conOrg(A) UPDATE sobre filas de B afecta 0 filas", upd === 0);

    // El DELETE dejó de existir para el rol de app (REVOKE, anti-"reciclador" de
    // docs/06 §3: borrar y recrear reseteaba contador y ventana gratis). Es una
    // garantía MÁS FUERTE que la de RLS: no son "0 filas afectadas", es que no puede
    // borrar en absoluto — ni las suyas ni las de otra org. Archivar es activa=false.
    const del = await conOrg(app, A, async (c) => {
      try { await c.query("DELETE FROM automatizaciones WHERE org_id = $1", [B]); return "permitido"; }
      catch (e) { return (e as { code?: string }).code; }
    });
    check("el app NO puede borrar automatizaciones (revocado, 42501)", del === "42501");

    let fkBloqueado = false;
    try {
      await conOrg(app, A, async (c) => {
        await c.query(
          "INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1, $2, 1, 'lista')",
          [B1, A],
        );
      });
    } catch { fkBloqueado = true; }
    check("conOrg(A) NO puede colgar una versión de la automatización de B (FK compuesta)", fkBloqueado);

    console.log("\n4. Membresía VIVA: expulsar pega al instante (docs/13 §1):");
    const m1 = await conOrg(app, A, (c) => leerMembresia(c, "u_ana"));
    check("leerMembresia(u_ana) en org A devuelve admin (viva)", m1?.rol === "admin");
    check("assertCan con la membresía viva permite ejecutar", permite(() => assertCan(m1 as Membresia, A, "ejecutar")));

    await admin.query("DELETE FROM memberships WHERE org_id = $1 AND user_id = 'u_ana'", [A]); // expulsión
    const m2 = await conOrg(app, A, (c) => leerMembresia(c, "u_ana"));
    check("tras expulsión, leerMembresia(u_ana) devuelve undefined", m2 === undefined);
    check("assertCan tras expulsión deniega (403 al instante)", deniega(() => assertCan(m2, A, "ejecutar")));
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ M2 (aislamiento por el camino de código) PROBADO" : "✗ FALLÓ"} — conOrg() aísla vía RLS, con rol no-dueño.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("Error:", e);
  console.error("¿Está el Postgres corriendo y el schema aplicado? (core/db/schema.sql)");
  console.error("¿Existe el rol de login automata_app? (lo crea el schema; con --auth=trust conecta sin password)");
  process.exit(1);
});
