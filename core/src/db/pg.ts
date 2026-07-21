import { Pool, type PoolClient } from "pg";

// Acceso a Postgres org-scoped (M2). En producción la app se conecta con el rol
// automata_app (no-dueño, RLS aplica). Aquí, sobre una conexión cualquiera, cada
// transacción hace SET LOCAL ROLE automata_app + fija app.current_org, de modo
// que TODA query adentro solo ve/escribe esa org — el aislamiento lo impone la
// base (db/schema.sql), no el código de la app.

export function crearPool(url: string): Pool {
  return new Pool({ connectionString: url });
}

/**
 * Ejecuta `fn` dentro de una transacción org-scoped: como automata_app y con
 * app.current_org = orgId. Commit al terminar, rollback si algo lanza.
 */
export async function conOrg<T>(pool: Pool, orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE automata_app");
    await c.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
