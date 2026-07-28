import { type Pool, type PoolClient } from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding: convertir un usuario recién autenticado (Clerk) en una org usable. Crear un
// tenant es OWNER-ONLY (el rol de app tiene REVOKE INSERT ON orgs), así que el trabajo real vive
// en dos funciones SECURITY DEFINER de la BD (app_orgs_de_usuario / app_provisionar_usuario, en
// db/schema.sql). Aquí SOLO se las llama — el módulo es framework-agnóstico, no toca RLS ni el
// pool dueño, y corre sobre el pool de app normal. El userId SIEMPRE viene del JWT verificado
// (nunca del cuerpo del cliente): las SD filtran por ese p_user, así el llamador solo ve/crea lo
// suyo. Lo usan el webhook `user.created` de Clerk (alta al registrarse) y GET /api/yo (alta
// perezosa al primer acceso + resolución de "¿en qué org estoy?").
// ─────────────────────────────────────────────────────────────────────────────

// Acepta el Pool de app o un PoolClient (ambos exponen .query). Estas llamadas NO necesitan
// conOrg: las SD no dependen de app.current_org (reciben el userId explícito).
type Consultable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export interface OrgDeUsuario {
  orgId: string;
  rol: "admin" | "operador";
  nombre: string;
}

/** Orgs a las que pertenece el usuario (admin primero, luego por antigüedad). Vacío = sin org. */
export async function orgsDeUsuario(cliente: Consultable, userId: string): Promise<OrgDeUsuario[]> {
  const r = await cliente.query<{ org_id: string; rol: "admin" | "operador"; nombre: string }>(
    "SELECT org_id, rol, nombre FROM app_orgs_de_usuario($1)",
    [userId],
  );
  return r.rows.map((f) => ({ orgId: f.org_id, rol: f.rol, nombre: f.nombre }));
}

/** Onboarding idempotente: si el usuario ya tiene org, la devuelve; si no, crea org + plan base +
 *  membresía admin. Devuelve la org resuelta y si se creó en ESTA llamada. Concurrencia-segura
 *  (advisory lock por-usuario dentro de la SD): dos llamadas simultáneas → una sola org. */
export async function provisionarUsuario(
  cliente: Consultable,
  userId: string,
  nombre?: string,
): Promise<{ org: OrgDeUsuario; creada: boolean }> {
  const antes = await orgsDeUsuario(cliente, userId);
  const orgId = (
    await cliente.query<{ id: string }>("SELECT app_provisionar_usuario($1, $2) AS id", [userId, nombre ?? null])
  ).rows[0]!.id;
  const orgs = await orgsDeUsuario(cliente, userId);
  const org = orgs.find((o) => o.orgId === orgId) ?? orgs[0]!;
  return { org, creada: antes.length === 0 };
}
