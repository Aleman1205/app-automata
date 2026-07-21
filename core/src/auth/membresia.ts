import { type PoolClient } from "pg";
import { type Membresia, type Rol } from "./roles.ts";

// ─────────────────────────────────────────────────────────────────────────────
// La membresía VIVA (docs/13 §1-§2). El control portante de la expulsión no es un
// claim en el token: es que assertCan se alimente de una lectura fresca de la tabla
// memberships EN CADA request. Este helper es ese único punto de lectura.
//
// Debe correr DENTRO de conOrg(orgObjetivo): así RLS ya acota memberships a esa org
// y no hace falta (ni conviene) filtrar por org_id en el WHERE — si el usuario no
// tiene fila viva en la org del contexto, regresa undefined → assertCan deniega →
// el request 403ea al instante tras quitarle la membresía.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lee la membresía viva del usuario en la org del contexto RLS actual.
 * Regresa undefined si no hay fila (ex-miembro, o nunca perteneció).
 */
export async function leerMembresia(c: PoolClient, userId: string): Promise<Membresia | undefined> {
  const r = await c.query<{ org_id: string; rol: Rol }>(
    "SELECT org_id, rol FROM memberships WHERE user_id = $1",
    [userId],
  );
  // RLS ya restringe a la org del contexto: a lo sumo una fila. Si RLS estuviera
  // roto y llegaran varias, tomar la primera sería inseguro, así que fallamos duro.
  if (r.rows.length > 1) {
    throw new Error(`memberships devolvió ${r.rows.length} filas para ${userId}: RLS no está acotando por org.`);
  }
  const fila = r.rows[0];
  if (!fila) return undefined;
  return { orgId: fila.org_id, userId, rol: fila.rol };
}
