import { type PoolClient } from "pg";
import { type Membresia } from "../auth/roles.ts";

// ─────────────────────────────────────────────────────────────────────────────
// La capa HTTP framework-agnóstica (el "wrapping"). Modela una request con efecto y
// sus 8 capas (docs/13 §3 / docs/14). Lo externo (Clerk, rate-limit store) entra por
// PUERTOS, así el pipeline se prueba entero sin servicios reales; el route.ts de Next
// solo traduce NextRequest → Solicitud y llama al handler compuesto.
// ─────────────────────────────────────────────────────────────────────────────

export type Metodo = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Solicitud {
  metodo: Metodo;
  orgId?: string; // de la ruta (/orgs/:orgId/...), NUNCA del cuerpo del cliente
  sesionToken?: string; // cookie de sesión (Clerk) — httpOnly, no en la URL
  origen?: string; // header Origin (para CSRF)
  hostEsperado?: string; // el origen propio; el adaptador SIEMPRE debe poblarlo (si falta, CSRF niega)
  ip?: string; // el adaptador debe pasarla YA SANEADA (IP de conexión del edge, no XFF crudo)
  cuerpo?: unknown;
}

export interface Respuesta {
  status: number;
  cuerpo: unknown;
}

/** Lo que la autenticación (Clerk, JWT verificado en el servidor) resuelve. */
export interface Identidad {
  userId: string;
  mfaVerificadoEn?: Date; // para el step-up: recencia del factor MFA
}

// ── Puertos de lo externo (impl real: Clerk / Upstash; impl fake en los tests) ──
export interface Sesion {
  autenticar(s: Solicitud): Promise<Identidad | null>;
}
export interface RateLimiter {
  // CONTRATO: debe ser FAIL-CLOSED — si el store está caído, la impl debe negar
  // (devolver false o lanzar), NUNCA 'return true'. La clave que recibe ya viene
  // priorizada (IP saneada → token → 'anon').
  permitir(clave: string): Promise<boolean>;
}

/** Validación de entrada (impl real: Zod; el core no depende de Zod). */
export interface Esquema<T> {
  analizar(x: unknown): { ok: true; valor: T } | { ok: false; problemas: string[] };
}

/** Lo que recibe el handler: identidad + membresía VIVA + org + input validado + el
 *  cliente PG ya dentro de conOrg (RLS acotado a la org). */
export interface Contexto<T> {
  identidad: Identidad;
  membresia: Membresia;
  orgId: string;
  input: T;
  cliente: PoolClient;
}

// Constructores de respuesta con los códigos correctos por capa.
export const R = {
  ok: (cuerpo: unknown = { ok: true }): Respuesta => ({ status: 200, cuerpo }),
  creado: (cuerpo: unknown): Respuesta => ({ status: 201, cuerpo }),
  malParametro: (msg: string): Respuesta => ({ status: 400, cuerpo: { error: msg } }),
  noAutenticado: (): Respuesta => ({ status: 401, cuerpo: { error: "no_autenticado" } }),
  prohibido: (msg = "prohibido"): Respuesta => ({ status: 403, cuerpo: { error: msg } }),
  metodoNoPermitido: (): Respuesta => ({ status: 405, cuerpo: { error: "metodo_no_permitido" } }),
  stepUp: (): Respuesta => ({ status: 403, cuerpo: { error: "step_up_requerido" } }),
  cuota: (msg: string): Respuesta => ({ status: 402, cuerpo: { error: "cuota_excedida", detalle: msg } }),
  rate: (): Respuesta => ({ status: 429, cuerpo: { error: "demasiadas_peticiones" } }),
};
