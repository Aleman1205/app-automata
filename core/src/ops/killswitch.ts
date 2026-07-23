import { type Pool, type PoolClient } from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// Kill-switch de incidente (docs/14 §3 / docs/11 §10). El ENFORCEMENT vive en la BD.
// DOS capas, defensa en profundidad:
//   1. verificar_freno(op)  — GUARD TEMPRANO callable por el rol de app. Se llama
//      ANTES del trabajo caro/irreversible (correr el código de IA, abrir CMA, cobrar).
//      Es el que hace real el freno de ejecuciones: el run corre y RECIÉN DESPUÉS
//      inserta en `ejecuciones`, así que el trigger del ledger llegaba tarde.
//   2. triggers en versiones/ejecuciones — BACKSTOP sobre el ledger (por si un camino
//      olvida el guard). Congelan builds/ejecuciones "de verdad".
// El rol de app no puede apagar ninguna (interruptores/suspensiones revocados).
//
// Este módulo: traduce el RAISE 'SERVICIO_SUSPENDIDO:<motivo>' a ServicioSuspendido;
// expone el guard (verificarFreno); las palancas de OPS (dueño) con bitácora; y la
// lectura de la palanca de cobros (para el path de Stripe). Diseñado para probarse
// en staging (checklist §10).
// ─────────────────────────────────────────────────────────────────────────────

export type Operacion = "builds" | "ejecuciones";
export type Palanca = Operacion | "cobros";
// Motivos que puede lanzar la BD: las palancas, 'org' (suspensión) y 'contexto'
// (el app corrió sin app.current_org → fail-closed; nunca debería pasar).
export type MotivoSuspension = Palanca | "org" | "contexto";

export class ServicioSuspendido extends Error {
  constructor(public readonly motivo: MotivoSuspension) {
    super(`Servicio suspendido (${descripcion(motivo)}) — incidente.`);
    this.name = "ServicioSuspendido";
  }
}
function descripcion(m: MotivoSuspension): string {
  if (m === "org") return "org suspendida";
  if (m === "contexto") return "sin contexto de org";
  return `${m} congelados`;
}

/** Traduce el 'SERVICIO_SUSPENDIDO:<motivo>' de la BD a ServicioSuspendido; re-lanza
 *  cualquier otro error. Lo aplican los callers de build/run/cobro al insertar o al
 *  llamar verificar_freno. */
export function comoSuspension(e: unknown): never {
  const msg = (e as { message?: string })?.message ?? "";
  const m = /SERVICIO_SUSPENDIDO:(builds|ejecuciones|cobros|org|contexto)/.exec(msg);
  if (m) throw new ServicioSuspendido(m[1] as MotivoSuspension);
  throw e;
}

/**
 * GUARD TEMPRANO: llámalo ANTES de correr el código de IA / abrir CMA / cobrar. Lanza
 * ServicioSuspendido si la operación está congelada globalmente o la org suspendida.
 * Corre bajo conOrg (usa app.current_org); es la razón por la que el freno de
 * ejecuciones muerde ANTES de ejecutar, no después de registrar.
 */
export async function verificarFreno(c: PoolClient | Pool, op: Palanca): Promise<void> {
  await c.query("SELECT verificar_freno($1)", [op]).catch(comoSuspension);
}

/** Azúcar para el path de facturación: aborta el cobro si la palanca de cobros está
 *  congelada. Todo cargo/creación de invoice DEBE llamar esto antes de tocar Stripe. */
export async function exigirCobrosActivos(c: PoolClient | Pool): Promise<void> {
  await verificarFreno(c, "cobros");
}

// ── Palancas de OPS (conexión de DUEÑO) ──────────────────────────────────────
// Cada palanca deja asiento en bitacora_kill (auditoría append-only, docs/14 §3).
const COL: Record<Palanca, string> = { builds: "builds", ejecuciones: "ejecuciones", cobros: "cobros" };

async function anota(owner: Pool, accion: string, palanca: string | null, orgId: string | null, motivo: string | null, actor?: string): Promise<void> {
  await owner.query(
    "INSERT INTO bitacora_kill (actor, accion, palanca, org_id, motivo) VALUES ($1,$2,$3,$4,$5)",
    [actor ?? null, accion, palanca, orgId, motivo ?? null],
  );
}

export async function congelar(owner: Pool, palanca: Palanca, actor?: string): Promise<void> {
  await owner.query(`UPDATE interruptores SET ${COL[palanca]} = true, actualizado = now()`);
  await anota(owner, "congelar", palanca, null, null, actor);
}
export async function descongelar(owner: Pool, palanca: Palanca, actor?: string): Promise<void> {
  await owner.query(`UPDATE interruptores SET ${COL[palanca]} = false, actualizado = now()`);
  await anota(owner, "descongelar", palanca, null, null, actor);
}
export async function suspenderOrg(owner: Pool, orgId: string, motivo?: string, actor?: string): Promise<void> {
  await owner.query("INSERT INTO suspensiones (org_id, motivo) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET motivo = EXCLUDED.motivo", [orgId, motivo ?? null]);
  await anota(owner, "suspender", "org", orgId, motivo ?? null, actor);
}
export async function reactivarOrg(owner: Pool, orgId: string, actor?: string): Promise<void> {
  // El borrado de suspensiones pierde la evidencia; la bitácora la conserva (append-only).
  await owner.query("DELETE FROM suspensiones WHERE org_id = $1", [orgId]);
  await anota(owner, "reactivar", "org", orgId, null, actor);
}

export interface EstadoInterruptores {
  builds: boolean;
  ejecuciones: boolean;
  cobros: boolean;
}
export async function estado(owner: Pool): Promise<EstadoInterruptores> {
  const r = await owner.query<EstadoInterruptores>("SELECT builds, ejecuciones, cobros FROM interruptores");
  return r.rows[0] ?? { builds: false, ejecuciones: false, cobros: false };
}

/** ¿Están congelados los cobros? Lo lee el path de facturación (Stripe) antes de cobrar.
 *  Palanca separada del freno de builds/ejecuciones (docs/11 §10). Para ABORTAR el cobro
 *  usa exigirCobrosActivos; esto es solo la lectura booleana. */
export async function cobrosCongelados(c: PoolClient | Pool): Promise<boolean> {
  const r = await c.query<{ cobros: boolean }>("SELECT cobros FROM interruptores");
  return r.rows[0]?.cobros === true;
}
