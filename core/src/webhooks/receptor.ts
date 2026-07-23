import { type Pool, type PoolClient } from "pg";
import { type Verificador } from "./firma.ts";

// ─────────────────────────────────────────────────────────────────────────────
// El receptor de webhooks (docs/13 §4): la cadena completa, fail-closed.
//   1. Verificar la FIRMA sobre el cuerpo CRUDO → si no, 401, nunca se parsea.
//   2. Parsear el JSON (solo DESPUÉS de verificar).
//   3. Extraer SOLO el identificador del RECURSO FIRMADO (nunca el org_id del payload
//      — la org se deriva por lookup en NUESTRA DB para evitar el confused deputy).
//   4. DEDUPE + DESPACHO en UNA sola transacción (conexión de DUEÑO): el INSERT de
//      idempotencia y el efecto del handler commitean/rollbackean juntos, así un
//      handler que falla LIBERA el id para el reintento (at-least-once, no at-most-once).
//
// Corre con la conexión de dueño, no automata_app: el webhook de Stripe muta
// subscriptions, que el rol de app tiene revocado (M3), y webhook_events también.
// ─────────────────────────────────────────────────────────────────────────────

export interface Entrega {
  rawBody: string; // el cuerpo EXACTO recibido (route.ts DEBE usar req.text(), no req.json())
  headers: Record<string, string>;
}

// El identificador del recurso FIRMADO — lo único de confianza para derivar la org.
// NUNCA se expone organization_id del payload.
export type Recurso =
  | { fuente: "cma"; sessionId: string }
  | { fuente: "stripe"; customerId?: string; subscriptionId?: string };

export interface Evento {
  id: string; // clave de dedupe (webhook-id firmado en CMA; evt.id firmado en Stripe)
  tipo: string; // data.type (CMA) / type (Stripe)
  recurso: Recurso;
}

export type Resultado =
  | { estado: "rechazado"; motivo: string } // firma inválida / JSON ilegible → 401/400, NO ack
  | { estado: "ilegible" } // firmado pero sin forma procesable → 2xx ack (corta reintentos)
  | { estado: "duplicado"; evento: Evento } // ya procesado → 2xx ack, no-op
  | { estado: "aceptado"; evento: Evento }; // verificado, nuevo y despachado con éxito

export interface Config {
  verificador: Verificador;
  fuente: "cma" | "stripe";
  pool: Pool; // conexión de DUEÑO
}

function extraerEvento(fuente: "cma" | "stripe", parsed: unknown, idFirmado?: string): Evento | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (fuente === "cma") {
    // envelope { type:"event", id, data:{ type, id:<session>, organization_id, ... } }
    const id = idFirmado; // el webhook-id de la cabecera es la clave canónica de idempotencia
    const data = o["data"];
    if (typeof id !== "string" || id.length === 0 || typeof data !== "object" || data === null) return null;
    const d = data as Record<string, unknown>;
    const tipo = d["type"];
    const sessionId = d["id"];
    if (typeof tipo !== "string" || typeof sessionId !== "string" || sessionId.length === 0) return null;
    return { id, tipo, recurso: { fuente: "cma", sessionId } };
  }
  // Stripe: { id:<evt firmado en el body>, type, data:{ object:{ id, customer, ... } } }
  const id = o["id"];
  const tipo = o["type"];
  const data = o["data"];
  if (typeof id !== "string" || id.length === 0 || typeof tipo !== "string") return null;
  const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["object"] : undefined;
  const oo = typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {};
  const customerId = typeof oo["customer"] === "string" ? (oo["customer"] as string) : undefined;
  const subscriptionId = typeof oo["id"] === "string" ? (oo["id"] as string) : undefined;
  return { id, tipo, recurso: { fuente: "stripe", customerId, subscriptionId } };
}

/**
 * Verifica, parsea y —si es nuevo— despacha `procesar` DENTRO de la misma transacción
 * que registra el dedupe. `procesar` recibe el cliente de esa tx y el evento con el
 * recurso firmado; si lanza, se hace rollback y el id queda libre para el reintento.
 */
export async function recibir(
  entrega: Entrega,
  cfg: Config,
  procesar: (c: PoolClient, evento: Evento) => Promise<void>,
): Promise<Resultado> {
  // 1. Firma sobre el cuerpo crudo. Si falla, NO se parsea nada.
  const v = cfg.verificador.verificar(entrega.rawBody, entrega.headers);
  if (!v.ok) return { estado: "rechazado", motivo: `firma:${v.motivo}` };

  // 2. Parsear (después de verificar).
  let parsed: unknown;
  try {
    parsed = JSON.parse(entrega.rawBody);
  } catch {
    return { estado: "rechazado", motivo: "json_invalido" };
  }
  // 3. Extraer el recurso firmado (nunca el org del payload).
  const evento = extraerEvento(cfg.fuente, parsed, v.id);
  if (!evento) {
    // Firmado pero sin forma procesable: ack (2xx) para cortar reintentos infinitos;
    // si tenemos el id firmado, lo marcamos para no re-evaluarlo.
    if (v.id) {
      await cfg.pool.query(
        "INSERT INTO webhook_events (id, fuente, tipo) VALUES ($1,$2,'ilegible') ON CONFLICT (fuente,id) DO NOTHING",
        [v.id, cfg.fuente],
      );
    }
    return { estado: "ilegible" };
  }

  // 4. Dedupe + despacho ATÓMICOS.
  const c = await cfg.pool.connect();
  try {
    await c.query("BEGIN");
    const ins = await c.query(
      "INSERT INTO webhook_events (id, fuente, tipo) VALUES ($1,$2,$3) ON CONFLICT (fuente,id) DO NOTHING RETURNING id",
      [evento.id, cfg.fuente, evento.tipo],
    );
    if ((ins.rowCount ?? 0) === 0) {
      await c.query("COMMIT");
      return { estado: "duplicado", evento };
    }
    await procesar(c, evento); // en la MISMA tx: si lanza, rollback libera el id
    await c.query("COMMIT");
    return { estado: "aceptado", evento };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e; // el id NO quedó marcado → el reintento re-procesa (at-least-once)
  } finally {
    c.release();
  }
}
