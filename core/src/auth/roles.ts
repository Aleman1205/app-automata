// ─────────────────────────────────────────────────────────────────────────────
// Autorización intra-org (docs/13 §2). Dos capas distintas, ambas necesarias:
//   · RLS (db/schema.sql) = AISLAMIENTO por org_id.
//   · assertCan (aquí)    = ROL (qué puede hacer el miembro en su org).
// La membresía es la fuente de verdad del rol y se lee VIVA por request, no de un
// claim horneado — así expulsar a alguien pega en el siguiente request.
// ─────────────────────────────────────────────────────────────────────────────

export type Rol = "admin" | "operador";

export type Accion =
  | "ejecutar"
  | "descargar"
  | "crear_build"
  | "ajustar"
  | "invitar"
  | "quitar_gente"
  | "facturacion"
  | "borrar_org";

// La matriz de docs/13 §2. operador solo ejecuta y descarga; admin todo.
const MATRIZ: Record<Accion, Rol[]> = {
  ejecutar: ["admin", "operador"],
  descargar: ["admin", "operador"],
  crear_build: ["admin"],
  ajustar: ["admin"],
  invitar: ["admin"],
  quitar_gente: ["admin"],
  facturacion: ["admin"],
  borrar_org: ["admin"],
};

// Acciones peligrosas que exigen step-up MFA aunque la sesión esté viva (docs/13 §1).
export const REQUIERE_STEPUP: ReadonlySet<Accion> = new Set<Accion>(["facturacion", "borrar_org", "quitar_gente"]);

export interface Membresia {
  orgId: string;
  userId: string;
  rol: Rol;
}

export class NoAutorizado extends Error {}

export function puede(rol: Rol, accion: Accion): boolean {
  return MATRIZ[accion].includes(rol);
}

/**
 * Comprobación al inicio de CADA endpoint/acción con efecto (no en la UI).
 * `membresia` es la membresía viva del usuario en la org objetivo (de la tabla
 * memberships, leída por request). undefined = sin membresía → cross-org o
 * ex-miembro → denegado.
 */
export function assertCan(membresia: Membresia | undefined, orgObjetivo: string, accion: Accion): void {
  if (!membresia || membresia.orgId !== orgObjetivo) {
    throw new NoAutorizado(`Sin membresía en la org ${orgObjetivo} (cross-org o ex-miembro).`);
  }
  if (!puede(membresia.rol, accion)) {
    throw new NoAutorizado(`El rol '${membresia.rol}' no puede '${accion}'.`);
  }
}

/** ¿Esta acción necesita re-verificación MFA además de la sesión viva? */
export function necesitaStepUp(accion: Accion): boolean {
  return REQUIERE_STEPUP.has(accion);
}
