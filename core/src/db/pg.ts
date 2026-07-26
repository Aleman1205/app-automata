import { Pool, type PoolClient } from "pg";

// Acceso a Postgres org-scoped (M2). La corrección crítica de docs/11 §6: la app
// se conecta con un rol DEDICADO no-dueño (automata_app: LOGIN, NOSUPERUSER,
// NOBYPASSRLS). Así RLS aplica a TODA query sobre el pool —no solo a las envueltas
// en conOrg—, y sin app.current_org la sesión ve 0 filas (fail-closed).
//
// conOrg añade el contexto de org por transacción. El `SET LOCAL ROLE automata_app`
// es defensa en profundidad (si el pool se mal-configura a un rol superior, cae al
// de app); la garantía PRIMARIA es el rol de login + afirmarRolSeguro().

export function crearPool(url: string): Pool {
  // connectionTimeoutMillis: falla-RÁPIDO si la BD es inalcanzable al arrancar (blackhole
  // de red), en vez de colgar el bootstrap indefinidamente (revisión adversarial).
  return new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
}

/**
 * Abre el pool de la APP y AFIRMA el rol seguro antes de devolverlo. Es la forma
 * obligatoria de crear el pool de aplicación en producción: si la URL apunta por error
 * a un rol superusuario/BYPASSRLS (el aislamiento entre clientes quedaría inerte), esto
 * lanza al ARRANCAR — no en silencio a media operación. Cierra el pool si el guard falla
 * para no dejar conexiones colgadas.
 */
export async function crearPoolApp(url: string): Promise<Pool> {
  const pool = crearPool(url);
  try {
    await afirmarRolSeguro(pool);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
  return pool;
}

/**
 * Backstop de arranque (docs/11 §6): rechaza arrancar si el rol de conexión es
 * superusuario o tiene BYPASSRLS, porque con cualquiera de los dos RLS es INERTE y
 * el aislamiento entero sería teatro. Llamar una vez al abrir el pool en producción.
 */
export async function afirmarRolSeguro(pool: Pool): Promise<void> {
  const r = await pool.query<{ usuario: string; super: boolean; bypass: boolean }>(
    `SELECT current_user AS usuario, rolsuper AS super, rolbypassrls AS bypass
       FROM pg_roles WHERE rolname = current_user`,
  );
  const row = r.rows[0];
  if (!row) throw new Error("No se pudo leer el rol de conexión (pg_roles).");
  if (row.super || row.bypass) {
    throw new Error(
      `Rol de conexión inseguro '${row.usuario}' (superuser=${row.super}, bypassrls=${row.bypass}): ` +
        `RLS quedaría inerte. Conecta con un rol no-dueño NOSUPERUSER NOBYPASSRLS (automata_app). Ver docs/11 §6.`,
    );
  }
  // Punto ciego cerrado (revisión adversarial): un rol DUEÑO de las tablas —aunque NO sea
  // superuser ni BYPASSRLS— puede `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` y neutralizar
  // el aislamiento. El rol de app debe tener privilegios pero NO ser dueño (las migraciones
  // corren como el dueño, aparte). Se rechaza si posee cualquier tabla del esquema public.
  const own = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind IN ('r','p')
         AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
  );
  if ((own.rows[0]?.n ?? 0) > 0) {
    throw new Error(
      `Rol de conexión '${row.usuario}' es DUEÑO de tablas en 'public': podría DISABLE RLS y ` +
        `neutralizar el aislamiento. Usa un rol NO-dueño (automata_app); las migraciones corren aparte.`,
    );
  }
}

/**
 * Ejecuta `fn` dentro de una transacción org-scoped: como automata_app y con
 * app.current_org = orgId. Commit al terminar, rollback si algo lanza.
 */
export async function conOrg<T>(pool: Pool, orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE automata_app"); // defensa en profundidad; no la fuente del aislamiento
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
