// ─────────────────────────────────────────────────────────────────────────────
// Verificación del aislamiento por el CAMINO DE CÓDIGO real (Node → pg → RLS).
// Complementa db/test-aislamiento.sql (SQL puro) probando que conOrg() —lo que la
// app usará— aísla de verdad. Necesita un Postgres con el schema aplicado.
//
//   DATABASE_URL=postgres://... npm run verify:pg
//   (por defecto apunta al cluster temporal en 127.0.0.1:55432)
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";

const URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let ok = true;
const check = (nombre: string, paso: boolean) => {
  console.log(`  ${paso ? "✓" : "✗"} ${nombre}`);
  ok = ok && paso;
};

async function main() {
  const pool = crearPool(URL);
  try {
    // Semilla como superusuario (RLS bypassed): 2 orgs.
    await pool.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]);
    await pool.query("INSERT INTO orgs (id, nombre) VALUES ($1,'M2 test A'), ($2,'M2 test B')", [A, B]);

    // conOrg(A): inserta y lee — solo ve lo suyo.
    const nA = await conOrg(pool, A, async (c) => {
      await c.query("INSERT INTO automatizaciones (org_id, nombre) VALUES ($1, 'via conOrg A')", [A]);
      const r = await c.query("SELECT count(*)::int AS n FROM automatizaciones");
      return r.rows[0].n as number;
    });
    check("conOrg(A) ve su propia automatización (1)", nA === 1);

    // conOrg(A) no puede leer las de B aunque las pida por id.
    const nAsobreB = await conOrg(pool, A, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id = $1", [B]);
      return r.rows[0].n as number;
    });
    check("conOrg(A) NO ve nada de B por org_id (cross-tenant)", nAsobreB === 0);

    // conOrg(B) no ve la que A insertó.
    const nB = await conOrg(pool, B, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM automatizaciones");
      return r.rows[0].n as number;
    });
    check("conOrg(B) NO ve la automatización de A (0)", nB === 0);

    // conOrg(B) no puede escribir en A (WITH CHECK).
    let bloqueado = false;
    try {
      await conOrg(pool, B, async (c) => {
        await c.query("INSERT INTO automatizaciones (org_id, nombre) VALUES ($1, 'intruso')", [A]);
      });
    } catch {
      bloqueado = true;
    }
    check("conOrg(B) NO puede escribir en la org A (WITH CHECK)", bloqueado);
  } finally {
    await pool.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]).catch(() => {});
    await pool.end();
  }

  console.log(`\n${ok ? "✓ M2 (aislamiento por el camino de código) PROBADO" : "✗ FALLÓ"} — conOrg() aísla vía RLS.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("Error:", e);
  console.error("¿Está el Postgres corriendo y el schema aplicado? (core/db/schema.sql)");
  process.exit(1);
});
