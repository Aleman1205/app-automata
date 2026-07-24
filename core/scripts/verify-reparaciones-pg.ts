// ─────────────────────────────────────────────────────────────────────────────
// Verificación del CIRCUIT BREAKER de reparaciones (docs/08 §2) contra Postgres.
// Las reparaciones son gratis e ILIMITADAS para el cliente (no gastan ajuste ni
// generación), pero cada una es un build real (~$1.8). El breaker es un DETECTOR DE
// AVERÍA con LATCH PERSISTENTE: cuenta reparaciones por automatización en una ventana
// RODANTE de 30 días (el ledger ES el contador → los builds FALLIDOS cuentan) y al
// tope ENGANCHA (automatizaciones.en_revision) — persiste entre meses hasta que ops lo
// rearme (limpiarRevision), no se auto-resetea el día 1. Blindado contra el rol de app:
// no puede resetear el contador (REVOKE UPDATE de versiones), backdatear creada (se
// normaliza), ni rearmar el latch (REVOKE UPDATE de automatizaciones).
//   ADMIN_URL=... DATABASE_URL=... npm run verify:reparaciones:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { iniciarAjuste, confirmarAjuste, fallarAjuste, automatizacionesEnRevision, limpiarRevision, AjusteNoPermitido } from "../src/ciclo/servicio.ts";
import { type Pool } from "pg";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const id = (n: number) => `e2000000-0000-0000-0000-00000000000${n}`;
const REPARA = id(1), OTRA = id(2), FALLA = id(3), FORZAR = id(4), LATCH = id(5), CAMBIOS = id(6), BACKDATE = id(7), MOROSA = id(8), COLUMNAS = id(9);

let admin: Pool;
let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const generaciones = () => admin.query<{ n: number }>("SELECT coalesce(sum(generaciones),0)::int AS n FROM uso_periodo WHERE org_id=$1", [A]).then((r) => r.rows[0]?.n ?? 0);
const numRep = (autoId: string) => admin.query<{ n: number }>("SELECT count(*)::int AS n FROM versiones WHERE automatizacion_id=$1 AND tipo='reparacion' AND creada >= now() - interval '30 days'", [autoId]).then((r) => r.rows[0]?.n ?? 0);
const latch = (autoId: string) => admin.query<{ e: string | null }>("SELECT en_revision::text AS e FROM automatizaciones WHERE id=$1", [autoId]).then((r) => r.rows[0]?.e ?? null);
const esNoPermitido = async (fn: () => Promise<unknown>, motivo: string) => {
  try { await fn(); return false; } catch (e) { return e instanceof AjusteNoPermitido && e.motivo === motivo; }
};
const code42501 = async (fn: () => Promise<unknown>) => {
  try { await fn(); return false; } catch (e) { return (e as { code?: string }).code === "42501"; }
};

async function main() {
  admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const seed = async (autoId: string) => {
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'a')", [autoId, A]);
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,tipo) VALUES ($1,$2,1,'lista',NULL)", [autoId, A]);
  };
  const reparar = (autoId: string) => conOrg(app, A, async (c) => {
    const i = await iniciarAjuste(c, autoId, "falla");            // regresión falla → reparación
    return confirmarAjuste(c, autoId, i.versionId);
  });
  const repararFallido = (autoId: string) => conOrg(app, A, async (c) => {
    const i = await iniciarAjuste(c, autoId, "falla");
    await fallarAjuste(c, autoId, i.versionId);                    // el build falla, pero CUENTA
  });
  let capOriginal = 10;

  try {
    capOriginal = (await admin.query<{ r: number }>("SELECT reparaciones AS r FROM planes WHERE plan='equipo'")).rows[0]?.r ?? 10;
    await admin.query("DELETE FROM orgs WHERE id=$1", [A]);
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [A]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [A]);
    await admin.query("UPDATE planes SET reparaciones=3 WHERE plan='equipo'"); // cap chico para probar
    for (const a of [REPARA, OTRA, FALLA, FORZAR, LATCH, CAMBIOS, BACKDATE, MOROSA, COLUMNAS]) await seed(a);

    console.log("1. Bajo el cap: reparaciones gratis, sin gastar generación:");
    const g0 = await generaciones();
    await reparar(REPARA); await reparar(REPARA);
    check("2 reparaciones (cap=3) proceden", (await numRep(REPARA)) === 2);
    check("no gastaron NI UNA generación (docs/08 §2: gratis)", (await generaciones()) === g0);
    check("aún NO enganchada (en_revision NULL)", (await latch(REPARA)) === null);

    console.log("\n2. Al tope: engancha el latch y corta ('en_revision'):");
    await reparar(REPARA); // 3ª: alcanza el cap → permitida + latch
    check("la 3ª (== cap) procede", (await numRep(REPARA)) === 3);
    check("y ENGANCHA el latch (en_revision seteado)", (await latch(REPARA)) !== null);
    check("la 4ª → AjusteNoPermitido('en_revision')", await esNoPermitido(() => reparar(REPARA), "en_revision"));
    check("y NO se creó el build (no se gastó el $1.8): sigue en 3", (await numRep(REPARA)) === 3);

    console.log("\n3. Los builds FALLIDOS cuentan ('el que falla mucho', docs/06 §3):");
    await repararFallido(FALLA); await repararFallido(FALLA); await repararFallido(FALLA);
    check("3 reparaciones fallidas enganchan el latch", (await latch(FALLA)) !== null);
    check("la 4ª (aunque las 3 fallaron) → cortada", await esNoPermitido(() => repararFallido(FALLA), "en_revision"));

    console.log("\n4. El cap es POR AUTOMATIZACIÓN (una rota no frena a las sanas):");
    check("OTRA automatización, sin tocar, sigue reparando", await conOrg(app, A, (c) => iniciarAjuste(c, OTRA, "falla")).then(() => true).catch(() => false));

    console.log("\n5. El LATCH persiste y solo ops lo rearma (no el cambio de mes ni el conteo):");
    await reparar(LATCH); await reparar(LATCH); await reparar(LATCH); // engancha
    check("LATCH enganchada", (await latch(LATCH)) !== null);
    // Borro TODAS sus reparaciones recientes (como dueño) → el conteo rodante cae a 0…
    await admin.query("DELETE FROM versiones WHERE automatizacion_id=$1 AND tipo='reparacion'", [LATCH]);
    check("...pero sigue BLOQUEADA: el latch manda sobre el conteo", await esNoPermitido(() => reparar(LATCH), "en_revision"));
    await limpiarRevision(admin, LATCH); // ops la rearma tras revisar
    check("tras limpiarRevision (ops), vuelve a aceptar reparaciones", await conOrg(app, A, (c) => iniciarAjuste(c, LATCH, "falla")).then(() => true).catch(() => false));

    console.log("\n6. El DUEÑO puede forzar una reparación tras revisar (bypass):");
    await admin.query("UPDATE planes SET reparaciones=0 WHERE plan='equipo'"); // todo bloqueado para el app
    check("con cap=0, el app no puede ni la 1ª", await esNoPermitido(() => reparar(FORZAR), "en_revision"));
    const forzado = await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,tipo) VALUES ($1,$2,50,'lista','reparacion') RETURNING id", [FORZAR, A]);
    check("el dueño (contexto NULL) SÍ crea la reparación (bypasea el breaker)", forzado.rowCount === 1);
    await admin.query("UPDATE planes SET reparaciones=3 WHERE plan='equipo'");

    console.log("\n7. BLINDAJE: el app no puede falsear el contador ni el latch:");
    check("app UPDATE versiones SET tipo='cambio' → 42501 (reset del contador)", await code42501(() => conOrg(app, A, (c) => c.query("UPDATE versiones SET tipo='cambio' WHERE automatizacion_id=$1 AND tipo='reparacion'", [REPARA]))));
    check("app UPDATE versiones SET creada=<mes pasado> → 42501", await code42501(() => conOrg(app, A, (c) => c.query("UPDATE versiones SET creada=now()-interval '40 days' WHERE automatizacion_id=$1", [REPARA]))));
    check("app UPDATE automatizaciones SET en_revision=NULL (auto-rearme) → 42501", await code42501(() => conOrg(app, A, (c) => c.query("UPDATE automatizaciones SET en_revision=NULL WHERE id=$1", [REPARA]))));
    check("app SÍ conserva UPDATE de versiones.estado (lo legítimo)", await conOrg(app, A, (c) => c.query("UPDATE versiones SET estado=estado WHERE automatizacion_id=$1", [REPARA])).then(() => true).catch(() => false));

    console.log("\n8. BACKDATE neutralizado: creada se normaliza a now() en el INSERT:");
    await conOrg(app, A, (c) => c.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,tipo,creada) VALUES ($1,$2,60,'lista','reparacion','2020-01-01')", [BACKDATE, A]));
    const cr = (await admin.query<{ vieja: boolean }>("SELECT creada < now() - interval '1 hour' AS vieja FROM versiones WHERE automatizacion_id=$1 AND numero=60", [BACKDATE])).rows[0]?.vieja;
    check("la reparación backdated a 2020 quedó con creada = now() (no evade la ventana)", cr === false);

    console.log("\n9. Org MOROSA/CANCELADA no dispara reparaciones (~$1.8):");
    await admin.query("UPDATE subscriptions SET estado='morosa' WHERE org_id=$1", [A]);
    check("org morosa: reparación → AjusteNoPermitido('suscripcion')", await esNoPermitido(() => reparar(MOROSA), "suscripcion"));
    await admin.query("UPDATE subscriptions SET estado='cancelada' WHERE org_id=$1", [A]);
    check("org cancelada: reparación → AjusteNoPermitido('suscripcion')", await esNoPermitido(() => reparar(MOROSA), "suscripcion"));
    await admin.query("UPDATE subscriptions SET estado='activa' WHERE org_id=$1", [A]);

    console.log("\n10. El breaker NO toca a los CAMBIOS (esos los acota la generación):");
    const gc = await generaciones();
    await conOrg(app, A, async (c) => { const i = await iniciarAjuste(c, CAMBIOS, "pasa"); return confirmarAjuste(c, CAMBIOS, i.versionId); });
    check("un cambio sí gasta generación (bound independiente)", (await generaciones()) === gc + 1);

    console.log("\n11. Ops ve las enganchadas y las rearma (el 'escalar'):");
    const enRev = await automatizacionesEnRevision(admin);
    check("REPARA (enganchada) aparece con su fecha de enganche", enRev.some((x) => x.autoId === REPARA && typeof x.desde === "string"));
    check("OTRA (sana) NO aparece", !enRev.some((x) => x.autoId === OTRA));

    console.log("\n12. El app no puede subir su propio cap (planes revocado):");
    check("app UPDATE planes SET reparaciones=999 → 42501", await code42501(() => conOrg(app, A, (c) => c.query("UPDATE planes SET reparaciones=999 WHERE plan='equipo'"))));
  } finally {
    await admin.query("UPDATE planes SET reparaciones=$1 WHERE plan='equipo'", [capOriginal]).catch((e) => console.error("RESTORE planes FALLÓ:", e.message));
    await admin.query("DELETE FROM orgs WHERE id=$1", [A]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ CIRCUIT BREAKER DE REPARACIONES PROBADO" : "✗ FALLÓ"} — latch persistente, ventana rodante, cuenta fallidas, morosa no dispara, y el app no puede falsear contador/latch/creada.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
