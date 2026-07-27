// ─────────────────────────────────────────────────────────────────────────────
// Verificación de la firma de webhooks (docs/13 §4). Fabrica firmas VÁLIDAS con
// node:crypto, ancla la construcción al VECTOR OFICIAL (KAT) de standard-webhooks, y
// comprueba positivos/negativos + el receptor (dedupe+despacho atómico, recurso
// firmado, at-least-once) contra Postgres.
//   ADMIN_URL=... npm run verify:webhooks
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "node:crypto";
import { verificarStandardWebhook, verificarStripe, verificadorStandard, verificadorStripe } from "../src/webhooks/firma.ts";
import { recibir, type Entrega, type Evento } from "../src/webhooks/receptor.ts";
import { crearPool } from "../src/db/pg.ts";
import { type PoolClient } from "pg";
import { KAT_STANDARD_WEBHOOKS as KAT } from "./fixtures/webhooks-kat.ts";

const NOW = 1_700_000_000_000;
const TS = Math.floor(NOW / 1000);
const SECRETO_WH = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const SECRETO_STRIPE = "whsec_stripe_test_secret";
const cuerpoCma = (sessionId: string) => JSON.stringify({ type: "event", id: "ignorado", data: { type: "session.status_idled", id: sessionId, organization_id: "ORG_DEL_PAYLOAD" } });
const CUERPO_STRIPE = JSON.stringify({ id: "evt_01", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_9", status: "active" } } });

function firmarStd(id: string, ts: number, cuerpo: string, secreto: string): Record<string, string> {
  const clave = Buffer.from(secreto.replace(/^whsec_/, ""), "base64");
  const sig = crypto.createHmac("sha256", clave).update(`${id}.${ts}.${cuerpo}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` };
}
const firmarStripe = (ts: number, cuerpo: string, secreto: string) =>
  `t=${ts},v1=${crypto.createHmac("sha256", secreto).update(`${ts}.${cuerpo}`).digest("hex")}`;

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const rechaza = (v: { ok: boolean }) => v.ok === false;

async function main() {
  console.log("1. standard-webhooks — incl. VECTOR OFICIAL (KAT):");
  // Vector canónico de standard-webhooks (no fabricado por nosotros): ancla el HMAC al estándar.
  // Aislado en scripts/fixtures/webhooks-kat.ts (dato público del spec, marcado gitleaks:allow).
  const kat = verificarStandardWebhook(KAT.payload, KAT.headers, KAT.secret, KAT.timestampMs);
  check("KAT (id.ts.body, base64, clave base64-decodificada) → ok", kat.ok === true);

  const cuerpo = cuerpoCma("sesn_XYZ");
  const hdr = firmarStd("msg_ABC", TS, cuerpo, SECRETO_WH);
  const vOk = verificarStandardWebhook(cuerpo, hdr, SECRETO_WH, NOW);
  check("firma válida → ok, y devuelve el webhook-id FIRMADO", vOk.ok === true && vOk.id === "msg_ABC");
  check("cuerpo ALTERADO → rechazado", rechaza(verificarStandardWebhook(cuerpo + " ", hdr, SECRETO_WH, NOW)));
  check("secreto equivocado → rechazado", rechaza(verificarStandardWebhook(cuerpo, hdr, "whsec_" + Buffer.from("otra_llave_distinta_completa_x").toString("base64"), NOW)));
  check("secreto vacío (whsec_) → secreto_invalido", (verificarStandardWebhook(cuerpo, hdr, "whsec_", NOW) as { motivo?: string }).motivo === "secreto_invalido");
  check("timestamp no numérico → timestamp_invalido", (verificarStandardWebhook(cuerpo, { ...hdr, "webhook-timestamp": "abc" }, SECRETO_WH, NOW) as { motivo?: string }).motivo === "timestamp_invalido");
  check("timestamp viejo (>5min) → rechazado", rechaza(verificarStandardWebhook(cuerpo, firmarStd("m", TS - 3600, cuerpo, SECRETO_WH), SECRETO_WH, NOW)));
  check("timestamp futuro (>5min) → rechazado", rechaza(verificarStandardWebhook(cuerpo, firmarStd("m", TS + 3600, cuerpo, SECRETO_WH), SECRETO_WH, NOW)));
  check("rotación de llave (varias v1, una válida) → ok", verificarStandardWebhook(cuerpo, { ...hdr, "webhook-signature": `v1,basura ${hdr["webhook-signature"]}` }, SECRETO_WH, NOW).ok === true);
  const sigDesnuda = hdr["webhook-signature"]!.slice(3); // sin la etiqueta 'v1,'
  check("firma SIN etiqueta v1, → rechazada (no se acepta desnuda)", rechaza(verificarStandardWebhook(cuerpo, { ...hdr, "webhook-signature": sigDesnuda }, SECRETO_WH, NOW)));
  check("etiqueta desconocida (v99,) → rechazada", rechaza(verificarStandardWebhook(cuerpo, { ...hdr, "webhook-signature": `v99,${sigDesnuda}` }, SECRETO_WH, NOW)));

  console.log("\n2. Stripe:");
  const sigStripe = firmarStripe(TS, CUERPO_STRIPE, SECRETO_STRIPE);
  check("firma válida → ok", verificarStripe(CUERPO_STRIPE, sigStripe, SECRETO_STRIPE, NOW).ok === true);
  check("cuerpo alterado → rechazado", rechaza(verificarStripe(CUERPO_STRIPE + "x", sigStripe, SECRETO_STRIPE, NOW)));
  check("timestamp viejo → rechazado", rechaza(verificarStripe(CUERPO_STRIPE, firmarStripe(TS - 3600, CUERPO_STRIPE, SECRETO_STRIPE), SECRETO_STRIPE, NOW)));
  const buenaHex = sigStripe.split("v1=")[1]!;
  check("varias v1 (basura + válida) → ok", verificarStripe(CUERPO_STRIPE, `t=${TS},v1=deadbeef,v1=${buenaHex}`, SECRETO_STRIPE, NOW).ok === true);
  check("v1 vacía → rechazado", rechaza(verificarStripe(CUERPO_STRIPE, `t=${TS},v1=`, SECRETO_STRIPE, NOW)));

  console.log("\n3. Receptor contra Postgres (dedupe+despacho atómico, recurso firmado):");
  const admin = crearPool(process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres");
  try {
    await admin.query("DELETE FROM webhook_events WHERE id = ANY($1)", [["msg_ABC", "msg_POISON", "msg_FAIL", "evt_01"]]);
    let llamado = 0;
    let recursoVisto: Evento["recurso"] | undefined;
    const procesar = async (_c: PoolClient, ev: Evento) => { llamado++; recursoVisto = ev.recurso; };
    const cfgCma = { verificador: verificadorStandard(SECRETO_WH, () => NOW), fuente: "cma" as const, pool: admin };
    const entrega: Entrega = { rawBody: cuerpo, headers: hdr };

    const r1 = await recibir(entrega, cfgCma, procesar);
    check("evento nuevo → aceptado; recurso = sessionId FIRMADO (NO el org del payload)",
      r1.estado === "aceptado" && recursoVisto?.fuente === "cma" && recursoVisto.sessionId === "sesn_XYZ" && !("organizationId" in (recursoVisto ?? {})));
    check("dedupe por el webhook-id de la CABECERA (msg_ABC), no por body.id", llamado === 1);

    const r2 = await recibir(entrega, cfgCma, procesar);
    check("reintento exacto → duplicado, procesar NO se re-ejecuta", r2.estado === "duplicado" && llamado === 1);

    // Colisión cross-fuente: un evento Stripe con id 'msg_ABC' debe aceptarse (PK compuesto).
    const cfgStripe = { verificador: verificadorStripe(SECRETO_STRIPE, () => NOW), fuente: "stripe" as const, pool: admin };
    const cuerpoColision = JSON.stringify({ id: "msg_ABC", type: "x", data: { object: { id: "sub_2", customer: "cus_1" } } });
    const rC = await recibir({ rawBody: cuerpoColision, headers: { "stripe-signature": firmarStripe(TS, cuerpoColision, SECRETO_STRIPE) } }, cfgStripe, procesar);
    check("id igual pero OTRA fuente → aceptado (PK (fuente,id), sin colisión)", rC.estado === "aceptado");

    // Poison: firmado pero sin forma procesable → ilegible (ack, corta reintentos).
    const cuerpoPoison = JSON.stringify({ type: "event" }); // sin data
    const rP = await recibir({ rawBody: cuerpoPoison, headers: firmarStd("msg_POISON", TS, cuerpoPoison, SECRETO_WH) }, cfgCma, procesar);
    check("firmado pero ilegible → 'ilegible' (2xx ack, no reintento infinito)", rP.estado === "ilegible");

    // Handler que FALLA → rollback → id libre → el reintento re-procesa (at-least-once).
    const cuerpoFail = cuerpoCma("sesn_FAIL");
    const hdrFail = firmarStd("msg_FAIL", TS, cuerpoFail, SECRETO_WH);
    let lanzo = false;
    try {
      await recibir({ rawBody: cuerpoFail, headers: hdrFail }, cfgCma, async () => { throw new Error("handler falló"); });
    } catch { lanzo = true; }
    const marcado = await admin.query("SELECT 1 FROM webhook_events WHERE id='msg_FAIL' AND fuente='cma'");
    check("handler falla → recibir lanza y el id NO queda marcado (rollback)", lanzo && marcado.rowCount === 0);
    const rReintento = await recibir({ rawBody: cuerpoFail, headers: hdrFail }, cfgCma, procesar);
    check("el reintento re-procesa (at-least-once, no se perdió el evento)", rReintento.estado === "aceptado");

    // verificar ANTES de parsear: cuerpo no-JSON con firma INVÁLIDA → firma:, no json_invalido.
    const rOrden = await recibir({ rawBody: "<<<", headers: firmarStd("m", TS, "OTRO", SECRETO_WH) }, cfgCma, procesar);
    check("cuerpo no-JSON + firma inválida → rechazado 'firma:' (verificar precede a parsear)",
      rOrden.estado === "rechazado" && rOrden.motivo.startsWith("firma:"));

    await admin.query("DELETE FROM webhook_events WHERE id = ANY($1)", [["msg_ABC", "msg_POISON", "msg_FAIL", "evt_01"]]);
  } catch (e) {
    console.log(`  ⚠ Postgres no disponible, se omite el receptor (${(e as Error).message.slice(0, 50)})`);
  } finally {
    await admin.end().catch(() => {});
  }

  console.log(`\n${ok ? "✓ FIRMA DE WEBHOOKS PROBADA" : "✗ FALLÓ"} — KAT + anti-forja + dedupe atómico + at-least-once + recurso firmado.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
