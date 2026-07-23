import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Verificación de firma de webhooks ENTRANTES (docs/13 §4) — la autenticación del
// único camino que se salta el pipeline de 8 capas. Dos esquemas, ambos HMAC-SHA256
// sobre el CUERPO CRUDO (re-serializar rompe el MAC), con ventana anti-replay y
// comparación de tiempo CONSTANTE:
//
//   · CMA / Anthropic → standard-webhooks (Svix): secreto whsec_<base64>, cabeceras
//     webhook-id/webhook-timestamp/webhook-signature, firma sobre `id.timestamp.body`.
//   · Stripe → cabecera `t=<ts>,v1=<hexsig>`, firma sobre `ts.body`.
//
// NOTA de producción: prefiere el verificador del SDK del proveedor
// (`client.beta.webhooks.unwrap` de @anthropic-ai/sdk; `stripe.webhooks.constructEvent`)
// — no rodar cripto propia. Esta impl es la REFERENCIA dependency-free (y lo que
// prueban los tests); el receptor (receptor.ts) acepta cualquier Verificador por puerto.
// ─────────────────────────────────────────────────────────────────────────────

export type Motivo =
  | "timestamp_ausente"
  | "timestamp_invalido"
  | "timestamp_fuera_de_ventana"
  | "firma_ausente"
  | "firma_no_coincide"
  | "secreto_invalido";

// En éxito, `id` es el identificador FIRMADO y canónico de idempotencia (el
// webhook-id de la cabecera en standard-webhooks). Stripe no lo trae en cabecera —
// su evt.id va firmado dentro del cuerpo, así que el receptor lo toma de ahí.
export type Verificacion = { ok: true; timestampMs: number; id?: string } | { ok: false; motivo: Motivo };

/** Puerto: verifica una entrega cruda y sus cabeceras. Impl real = SDK del proveedor
 *  o las funciones de abajo. */
export interface Verificador {
  verificar(rawBody: string, headers: Record<string, string>): Verificacion;
}

const VENTANA_MS = 5 * 60 * 1000; // ±5 min anti-replay (igual que unwrap() de Anthropic)

// Comparación de tiempo constante sobre strings (evita el oráculo de timing). Longitudes
// distintas → false, sin cortocircuito que filtre la longitud.
function igualesConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // compara contra sí mismo para no filtrar por tiempo que falló por longitud
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

const hCaseInsensitive = (headers: Record<string, string>, nombre: string): string | undefined => {
  const clave = Object.keys(headers).find((k) => k.toLowerCase() === nombre.toLowerCase());
  return clave ? headers[clave] : undefined;
};

/**
 * standard-webhooks (CMA/Anthropic). `headers` debe traer webhook-id,
 * webhook-timestamp, webhook-signature. El secreto es `whsec_<base64>`.
 */
export function verificarStandardWebhook(
  rawBody: string,
  headers: Record<string, string>,
  secreto: string,
  ahoraMs: number,
  ventanaMs = VENTANA_MS,
): Verificacion {
  const id = hCaseInsensitive(headers, "webhook-id");
  const ts = hCaseInsensitive(headers, "webhook-timestamp");
  const firma = hCaseInsensitive(headers, "webhook-signature");
  if (!ts) return { ok: false, motivo: "timestamp_ausente" };
  if (!firma) return { ok: false, motivo: "firma_ausente" };
  if (!id) return { ok: false, motivo: "firma_ausente" };

  const tsNum = Number(ts);
  if (!Number.isInteger(tsNum)) return { ok: false, motivo: "timestamp_invalido" };
  const timestampMs = tsNum * 1000;
  if (Math.abs(ahoraMs - timestampMs) > ventanaMs) return { ok: false, motivo: "timestamp_fuera_de_ventana" };

  // Buffer.from(_, 'base64') nunca lanza (decodifica lo que puede); solo un secreto
  // vacío tras quitar 'whsec_' es inválido → fail-closed.
  const clave = Buffer.from(secreto.replace(/^whsec_/, ""), "base64");
  if (clave.length === 0) return { ok: false, motivo: "secreto_invalido" };

  const esperada = crypto.createHmac("sha256", clave).update(`${id}.${ts}.${rawBody}`).digest("base64");
  // webhook-signature = lista separada por espacios; SOLO se aceptan entradas `v1,<base64>`
  // no vacías (una etiqueta desconocida o una firma desnuda sin `v1,` se descartan).
  const candidatas = firma.split(" ").filter((p) => p.startsWith("v1,")).map((p) => p.slice(3)).filter((s) => s.length > 0);
  const ok = candidatas.some((c) => igualesConstante(c, esperada));
  return ok ? { ok: true, timestampMs, id } : { ok: false, motivo: "firma_no_coincide" };
}

/**
 * Stripe: cabecera `Stripe-Signature: t=<ts>,v1=<hexsig>[,v1=...]`. El secreto es el
 * `whsec_...` de Stripe usado tal cual (no se decodifica).
 */
export function verificarStripe(
  rawBody: string,
  stripeSignature: string,
  secreto: string,
  ahoraMs: number,
  ventanaMs = VENTANA_MS,
): Verificacion {
  const partes = stripeSignature.split(",").map((p) => p.trim());
  let t: string | undefined;
  const v1s: string[] = [];
  for (const p of partes) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    if (k === "t") t = v;
    else if (k === "v1" && v.length > 0) v1s.push(v);
  }
  if (!t) return { ok: false, motivo: "timestamp_ausente" };
  if (v1s.length === 0) return { ok: false, motivo: "firma_ausente" };

  const tsNum = Number(t);
  if (!Number.isInteger(tsNum)) return { ok: false, motivo: "timestamp_invalido" };
  const timestampMs = tsNum * 1000;
  if (Math.abs(ahoraMs - timestampMs) > ventanaMs) return { ok: false, motivo: "timestamp_fuera_de_ventana" };

  const esperada = crypto.createHmac("sha256", secreto).update(`${t}.${rawBody}`).digest("hex");
  const ok = v1s.some((v) => igualesConstante(v, esperada));
  return ok ? { ok: true, timestampMs } : { ok: false, motivo: "firma_no_coincide" };
}

/** Verificadores como PUERTO, para inyectar en el receptor. */
export const verificadorStandard = (secreto: string, ahora: () => number = Date.now): Verificador => ({
  verificar: (raw, headers) => verificarStandardWebhook(raw, headers, secreto, ahora()),
});
export const verificadorStripe = (secreto: string, ahora: () => number = Date.now): Verificador => ({
  verificar: (raw, headers) => {
    const sig = hCaseInsensitive(headers, "stripe-signature");
    if (!sig) return { ok: false, motivo: "firma_ausente" };
    return verificarStripe(raw, sig, secreto, ahora());
  },
});
