// ─────────────────────────────────────────────────────────────────────────────
// Autorización intra-org (docs/13 §2). Dos capas distintas, ambas necesarias:
//   · RLS (db/schema.sql) = AISLAMIENTO por org_id.
//   · assertCan (aquí)    = ROL (qué puede hacer el miembro en su org).
// La membresía es la fuente de verdad del rol y se lee VIVA por request, no de un
// claim horneado — así expulsar a alguien pega en el siguiente request. El helper
// que la lee viva de la tabla vive en auth/membresia.ts (necesita la DB).
// ─────────────────────────────────────────────────────────────────────────────

export type Rol = "admin" | "operador";

export type Accion =
  | "ver"
  | "ejecutar"
  | "descargar"
  | "crear_build"
  | "ajustar"
  | "invitar"
  | "quitar_gente"
  | "facturacion"
  | "exportar_codigo"
  | "gestionar_espacios"
  | "borrar_org";

// Política por acción: quién puede + si exige step-up MFA. UN SOLO lugar, como
// Record EXHAUSTIVO: agregar una Accion nueva NO compila hasta clasificar su rol Y su
// step-up (deny-by-default para lo peligroso, corrección de la revisión — un allowlist
// de step-up fallaba abierto al olvidar una acción nueva).
//
// step-up (docs/13 §1): las acciones peligrosas exigen re-verificar MFA aunque la
// sesión esté viva: facturación, borrar org, **cambiar miembros (invitar o quitar)**,
// exportar código. 'invitar' entra porque añadir un admin con una cookie robada (sin
// poder pasar MFA) sería escalada/persistencia. 'exportar_codigo' = el FUENTE (≠
// 'descargar', que es el resultado y no es peligroso).
interface Politica {
  roles: Rol[];
  stepup: boolean;
}
const POLITICA: Record<Accion, Politica> = {
  ver: { roles: ["admin", "operador"], stepup: false }, // lectura del portafolio/panel/detalle (ambos roles)
  ejecutar: { roles: ["admin", "operador"], stepup: false },
  descargar: { roles: ["admin", "operador"], stepup: false },
  crear_build: { roles: ["admin"], stepup: false },
  ajustar: { roles: ["admin"], stepup: false },
  invitar: { roles: ["admin"], stepup: true },
  quitar_gente: { roles: ["admin"], stepup: true },
  facturacion: { roles: ["admin"], stepup: true },
  exportar_codigo: { roles: ["admin"], stepup: true },
  gestionar_espacios: { roles: ["admin"], stepup: false }, // reactivar/desactivar tras downgrade (docs/06 §9)
  borrar_org: { roles: ["admin"], stepup: true },
};

export interface Membresia {
  orgId: string;
  userId: string;
  rol: Rol;
}

export class NoAutorizado extends Error {}

export function puede(rol: Rol, accion: Accion): boolean {
  return POLITICA[accion].roles.includes(rol);
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
  return POLITICA[accion].stepup;
}
