// ─────────────────────────────────────────────────────────────────────────────
// Verificación del ciclo de vida en Postgres (docs/08), patrón reserva→confirma:
// el tipo se deriva de la regresión (no del llamador), el consumo ocurre al llegar a
// `ready` (un build fallido no gasta el ajuste), un cambio consume también una
// generación (M3), reparación no consume, un solo build en vuelo por automatización,
// y el TOCTOU concurrente. Corre por conOrg (RLS acotado, rol no-dueño).
//   ADMIN_URL=... DATABASE_URL=... npm run verify:ciclo:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import {
  iniciarAjuste, confirmarAjuste, fallarAjuste, congelar, estadoDelCiclo, reaparBuildsColgados,
  AjusteNoPermitido, AjusteEnCurso, AutomatizacionNoDisponible,
} from "../src/ciclo/servicio.ts";
import { type Pool, type PoolClient } from "pg";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTRA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PER = "2026-07";
const id = (n: number) => `c1000000-0000-0000-0000-00000000000${n}`;
const CICLO = id(1), INFLIGHT = id(2), FAIL = id(3), CONGELA = id(4), RACE = id(5), INACTIVA = id(6), AJENA = id(7);
const BRICK_GUARD = id(8), BRICK_ROBUST = id(9), TOCTOU_C = id(0);
const REAPER = "c1000000-0000-0000-0000-0000000000aa";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const lanza = async (fn: () => Promise<unknown>, clase: new (...a: never[]) => Error) => {
  try { await fn(); return false; } catch (e) { return e instanceof clase; }
};

async function abrirTx(pool: Pool, org: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE automata_app");
  await c.query("SELECT set_config('app.current_org', $1, true)", [org]);
  return c;
}
const cerrar = async (c: PoolClient, cmd: "COMMIT" | "ROLLBACK") => { await c.query(cmd).catch(() => {}); c.release(); };

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  // La v1 'lista' SELLA la entrega (trigger) → la automatización quedaría dentro de la
  // ventana de 30 días gratis, donde los cambios NO consumen ajuste. Este script prueba
  // la ruta DE PAGO (post-ventana), así que se retrasa la entrega 60 días. La ventana en
  // sí la cubre verify-ventana-pg.ts.
  const seedAuto = async (autoId: string, activa = true, ajustes = 0, estado = "ready") => {
    await admin.query("INSERT INTO automatizaciones (id, org_id, nombre, activa, ciclo_estado, ajustes_usados) VALUES ($1,$2,'a',$3,$4,$5)", [autoId, A, activa, estado, ajustes]);
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,1,'lista')", [autoId, A]);
    await admin.query("UPDATE automatizaciones SET entregada = now() - interval '60 days' WHERE id = $1", [autoId]);
  };
  const generaciones = () => admin.query<{ n: number }>("SELECT coalesce(sum(generaciones),0)::int AS n FROM uso_periodo WHERE org_id=$1", [A]).then((r) => r.rows[0]?.n ?? 0);
  const cuentaBuilding = (autoId: string) => admin.query<{ n: number }>("SELECT count(*)::int AS n FROM versiones WHERE automatizacion_id=$1 AND estado='building'", [autoId]).then((r) => r.rows[0]?.n ?? 0);
  // Un cambio completo = iniciar (regresión pasa) + confirmar al ready.
  const cambioCompleto = (autoId: string) => conOrg(app, A, async (c) => {
    const i = await iniciarAjuste(c, autoId, "pasa");
    return confirmarAjuste(c, autoId, i.versionId);
  });

  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, OTRA]]);
    // Plan 'equipo' (20 generaciones): ahora CADA build cobra una generación al arrancar
    // (trigger cobrar_build), y este script hace ~8 builds. Con 'base' (6) se agotaría la
    // cuota a media prueba — el tope de generaciones lo cubre verify-cuota-pg.ts.
    for (const o of [A, OTRA]) { await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [o]); await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [o]); }
    await seedAuto(CICLO); await seedAuto(INFLIGHT); await seedAuto(FAIL); await seedAuto(CONGELA);
    await seedAuto(RACE); await seedAuto(INACTIVA, false); await seedAuto(BRICK_GUARD); await seedAuto(BRICK_ROBUST); await seedAuto(TOCTOU_C); await seedAuto(REAPER);
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'ajena')", [AJENA, OTRA]);

    console.log("1. Reserva→confirma: 3 cambios consumen ajuste + generación → frozen:");
    const c1 = await cambioCompleto(CICLO), c2 = await cambioCompleto(CICLO), c3 = await cambioCompleto(CICLO);
    check("los 3 cambios consumen ajustes (1,2,3)", c1.ajustesUsados === 1 && c2.ajustesUsados === 2 && c3.ajustesUsados === 3);
    check("el 3º congela (frozen, 0 restantes)", c3.estado === "frozen" && c3.ajustesRestantes === 0);
    check("cada cambio consumió UNA generación del mes (M3): 3 en total", (await generaciones()) === 3);
    check("un 4º cambio → AjusteNoPermitido('frozen')", await (async () => { try { await cambioCompleto(CICLO); return false; } catch (e) { return e instanceof AjusteNoPermitido && e.motivo === "frozen"; } })());

    console.log("\n2. Reparación: gratis, no consume ajuste NI generación, incluso sobre frozen:");
    const rep = await conOrg(app, A, async (c) => { const i = await iniciarAjuste(c, CICLO, "falla"); check("  regresión falla → tipo reparación", i.tipo === "reparacion"); return confirmarAjuste(c, CICLO, i.versionId); });
    check("reparación sobre frozen → no consume (sigue frozen, 3 usados)", rep.estado === "frozen" && rep.ajustesUsados === 3);
    // docs/08 §2: la reparación es gratis e ILIMITADA ("es tu obligación, no un favor"),
    // así que queda exenta también del tope de generaciones (trigger cobrar_build).
    check("no consumió generación (siguen 3, no 4)", (await generaciones()) === 3);

    console.log("\n3. INDETERMINADO → cambio (fail-safe: cobra):");
    check("regresión indeterminada clasifica como cambio", (await conOrg(app, A, (c) => iniciarAjuste(c, INFLIGHT, "indeterminado"))).tipo === "cambio");

    console.log("\n4. Un solo build en vuelo por automatización (anti-spam):");
    // (INFLIGHT ya tiene una versión 'building' del paso 3, sin confirmar)
    check("2º ajuste mientras hay uno building → AjusteEnCurso", await lanza(() => conOrg(app, A, (c) => iniciarAjuste(c, INFLIGHT, "falla")), AjusteEnCurso));

    console.log("\n5. Build FALLIDO no gasta AJUSTE (pero sí la generación: tope de builds INICIADOS):");
    // CAMBIO de comportamiento (revisión adversarial): la generación se cobra al ARRANCAR
    // el build (docs/10 §8 "builds INICIADOS"), no al confirmarlo. Antes, iniciar+fallar en
    // bucle quemaba sesiones de CMA reales con el contador en 0 ("el que falla mucho",
    // docs/06 §3). El AJUSTE de los 3 sigue sin gastarse si el build falla.
    const gAntes = await generaciones();
    const iF = await conOrg(app, A, (c) => iniciarAjuste(c, FAIL, "pasa"));
    await conOrg(app, A, (c) => fallarAjuste(c, FAIL, iF.versionId));
    check("tras fallar: 0 ajustes usados (el ajuste no se gasta)", (await conOrg(app, A, (c) => estadoDelCiclo(c, FAIL))).ajustesUsados === 0);
    check("pero la generación se cobró al INICIAR (no se gasta dinero sin presupuesto)", (await generaciones()) === gAntes + 1);
    check("el 'en vuelo' quedó libre (0 building) → se puede reintentar", (await cuentaBuilding(FAIL)) === 0);
    const reintento = await cambioCompleto(FAIL);
    check("el reintento sí consume (ajuste 1)", reintento.ajustesUsados === 1);

    console.log("\n6. Idempotencia de confirmar (webhook duplicado no doble-consume):");
    const dup = await conOrg(app, A, async (c) => {
      const i = await iniciarAjuste(c, CONGELA, "pasa");
      await confirmarAjuste(c, CONGELA, i.versionId);
      return confirmarAjuste(c, CONGELA, i.versionId); // 2ª vez
    });
    check("confirmar dos veces → un solo consumo (1 usado, no 2)", dup.ajustesUsados === 1);

    console.log("\n7. Congelado voluntario y guardas de disponibilidad:");
    const cong = await conOrg(app, A, (c) => congelar(c, CONGELA));
    check("frozen voluntario NO miente: ajustesRestantes = 0 aunque queden usados<3", cong.estado === "frozen" && cong.ajustesRestantes === 0);
    check("tras congelar, un cambio → AjusteNoPermitido('frozen')", await (async () => { try { await cambioCompleto(CONGELA); return false; } catch (e) { return e instanceof AjusteNoPermitido && e.motivo === "frozen"; } })());

    console.log("\n8. Guardas de acceso (activa / cross-org):");
    check("automatización inactiva (activa=false, solo lectura) → rechazada", await lanza(() => conOrg(app, A, (c) => iniciarAjuste(c, INACTIVA, "pasa")), AutomatizacionNoDisponible));
    check("automatización de OTRA org (cross-org) → rechazada por RLS", await lanza(() => conOrg(app, A, (c) => iniciarAjuste(c, AJENA, "pasa")), AutomatizacionNoDisponible));

    console.log("\n9. TOCTOU: dos iniciar concurrentes sobre la misma automatización:");
    const t1 = await abrirTx(app, A);
    await iniciarAjuste(t1, RACE, "pasa"); // toma el cerrojo, inserta building (sin commit)
    const t2 = await abrirTx(app, A);
    const p2 = iniciarAjuste(t2, RACE, "pasa").then(() => "ok").catch((e) => e); // BLOQUEA en FOR UPDATE
    const pendiente = await Promise.race([p2.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 150))]);
    await cerrar(t1, "COMMIT"); // libera → p2 sigue, ve el building committeado
    const r2 = await p2;
    await cerrar(t2, "ROLLBACK");
    check("el 2º iniciar BLOQUEA hasta el commit del 1º", pendiente === true);
    check("y luego es rechazado (AjusteEnCurso), sin doble build", r2 instanceof AjusteEnCurso && (await cuentaBuilding(RACE)) === 1);

    console.log("\n11. Brick de confirmarAjuste cerrado (hallazgo de la revisión de la ventana):");
    // (a) GUARD: no se puede congelar con un CAMBIO en vuelo (evita el brick en origen).
    const iG = await conOrg(app, A, (c) => iniciarAjuste(c, BRICK_GUARD, "pasa")); // cambio building
    check("congelar con un cambio en vuelo → AjusteEnCurso (no ladrilla)", await (async () => {
      try { await conOrg(app, A, (c) => congelar(c, BRICK_GUARD)); return false; } catch (e) { return e instanceof AjusteEnCurso; }
    })());
    const eg = await conOrg(app, A, (c) => confirmarAjuste(c, BRICK_GUARD, iG.versionId));
    check("el cambio en vuelo se confirma normal (ready, 1 usado)", eg.estado === "ready" && eg.ajustesUsados === 1);

    // (b) RED DE SEGURIDAD: aunque quede frozen a mitad de vuelo (forzado como dueño,
    //     saltando el guard), confirmarAjuste ENTREGA la versión en vez de dejarla building.
    const iR = await conOrg(app, A, (c) => iniciarAjuste(c, BRICK_ROBUST, "pasa")); // cambio building
    await admin.query("UPDATE automatizaciones SET ciclo_estado='frozen' WHERE id=$1", [BRICK_ROBUST]); // peor caso
    await conOrg(app, A, (c) => confirmarAjuste(c, BRICK_ROBUST, iR.versionId)); // (loguea el incidente, no lanza)
    check("frozen a mitad de vuelo: la versión se ENTREGA (0 building, no revertida)", (await cuentaBuilding(BRICK_ROBUST)) === 0);
    check("la versión quedó 'lista'", (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM versiones WHERE id=$1 AND estado='lista'", [iR.versionId])).rows[0]?.n === 1);
    check("NO quedó ladrillada: una reparación posterior procede (docs/08 §2)", await conOrg(app, A, (c) => iniciarAjuste(c, BRICK_ROBUST, "falla")).then(() => true).catch(() => false));

    // (c) NO filtra entre orgs: congelar un auto AJENO (con cambio building) → no_existe
    //     uniforme, no 'build_en_vuelo' (que revelaría el estado de otra org).
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,tipo) VALUES ($1,$2,2,'building','cambio')", [AJENA, OTRA]);
    check("congelar un auto AJENO (con cambio en vuelo) → no_existe, NO build_en_vuelo (sin oracle cross-tenant)", await lanza(() => conOrg(app, A, (c) => congelar(c, AJENA)), AutomatizacionNoDisponible));

    // (d) TOCTOU: congelar toma FOR UPDATE → serializa con iniciarAjuste concurrente.
    const g1 = await abrirTx(app, A);
    await iniciarAjuste(g1, TOCTOU_C, "pasa"); // cambio building, cerrojo tomado, sin commit
    const pc = conOrg(app, A, (c) => congelar(c, TOCTOU_C)).then(() => "ok").catch((e) => e); // conexión nueva; BLOQUEA en FOR UPDATE
    const bloqueo = await Promise.race([pc.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 150))]);
    await cerrar(g1, "COMMIT"); // libera → congelar ve el cambio building committeado
    const rc = await pc;
    check("congelar BLOQUEA hasta el commit del iniciar concurrente (FOR UPDATE)", bloqueo === true);
    check("y luego lo rechaza (AjusteEnCurso), sin frozen+building coexistiendo", rc instanceof AjusteEnCurso);

    console.log("\n12. Reaper: builds 'building' AÑEJOS no ladrillan (auto-sanación + ops):");
    // Un 'building' añejo (proceso muerto / webhook nunca llegó) sembrado como dueño (que
    // bypasea la normalización de creada). iniciarAjuste debe reaper-earlo y PROCEDER.
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,creada) VALUES ($1,$2,2,'building', now() - interval '2 hours')", [REAPER, A]);
    const reanudado = await conOrg(app, A, (c) => iniciarAjuste(c, REAPER, "pasa", { staleMin: 60 }));
    check("un 'building' añejo se reaper-ea y el ajuste PROCEDE (no AjusteEnCurso)", typeof reanudado.versionId === "string");
    check("el 'building' añejo quedó 'failed'", (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM versiones WHERE automatizacion_id=$1 AND numero=2 AND estado='failed'", [REAPER])).rows[0]?.n === 1);
    check("un 'building' RECIENTE (el que acaba de crear) SÍ bloquea (AjusteEnCurso)", await lanza(() => conOrg(app, A, (c) => iniciarAjuste(c, REAPER, "pasa")), AjusteEnCurso));
    // Barrido de ops entre orgs.
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,creada) VALUES ($1,$2,9,'building', now() - interval '3 hours')", [CICLO, A]);
    check("reaparBuildsColgados (ops) marca los añejos → failed (≥1)", (await reaparBuildsColgados(admin, 60)) >= 1);

    console.log("\n10. Backstops de integridad en la BD:");
    check("UNIQUE(automatizacion_id, numero): numero duplicado → error 23505", await (async () => {
      try { await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,1,'x')", [CICLO, A]); return false; }
      catch (e) { return (e as { code?: string }).code === "23505"; }
    })());
    check("CHECK ajustes_usados<=3 (== MAX_AJUSTES): 4 → violación", await (async () => {
      try { await admin.query("UPDATE automatizaciones SET ajustes_usados=4 WHERE id=$1", [FAIL]); return false; }
      catch (e) { return (e as { code?: string }).code === "23514"; }
    })());
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, OTRA]]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ CICLO DE VIDA (Postgres) PROBADO" : "✗ FALLÓ"} — reserva→confirma, tipo derivado, fallidos gratis, sin oversell ni spam.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
