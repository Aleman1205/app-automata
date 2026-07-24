// ─────────────────────────────────────────────────────────────────────────────
// Verificación de la VENTANA DE 30 DÍAS de ajustes gratis (docs/06 §4: "los ajustes
// durante los primeros 30 días no cuentan") contra Postgres.
// Reglas decididas:
//   · La ventana se ancla a la ENTREGA (primera versión lista) — "lo que acaba de
//     recibir" —, se sella UNA vez y el app no puede moverla.
//   · Dentro de la ventana un CAMBIO no gasta uno de los 3 ajustes…
//   · …pero SÍ consume una generación del tope interno (2× espacios/mes, docs/08 §7):
//     es lo que acota al "ajustador infinito" de docs/06 §3.
//   · El contador vive en la BD: el rol de app no puede escribir ajustes_usados,
//     ciclo_estado ni entregada (antes podía resetearlos → ajustes infinitos).
//   ADMIN_URL=... DATABASE_URL=... npm run verify:ventana:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { iniciarAjuste, confirmarAjuste, estadoDelCiclo, congelar, AjusteNoPermitido } from "../src/ciclo/servicio.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PER = "2026-07";
const id = (n: number) => `d1000000-0000-0000-0000-00000000000${n}`;
const NUEVA = id(1), VIEJA = id(2), SINENTREGA = id(3), SELLO = id(4), ABUSO = id(5);

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const codigo = async (fn: () => Promise<unknown>, code: string) => {
  try { await fn(); return false; } catch (e) { return (e as { code?: string }).code === code; }
};

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const generaciones = () => admin.query<{ n: number }>("SELECT coalesce(sum(generaciones),0)::int AS n FROM uso_periodo WHERE org_id=$1", [A]).then((r) => r.rows[0]?.n ?? 0);
  const entregaDe = (autoId: string) => admin.query<{ e: string | null }>("SELECT entregada::text AS e FROM automatizaciones WHERE id=$1", [autoId]).then((r) => r.rows[0]?.e ?? null);
  // Un cambio completo = iniciar (regresión pasa) + confirmar.
  const cambio = (autoId: string) => conOrg(app, A, async (c) => {
    const i = await iniciarAjuste(c, autoId, "pasa");
    return confirmarAjuste(c, autoId, i.versionId);
  });
  // Siembra con v1 entregada; `diasAtras` retrasa la entrega para salir de la ventana.
  const seed = async (autoId: string, opts: { entregar?: boolean; diasAtras?: number } = {}) => {
    const { entregar = true, diasAtras = 0 } = opts;
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'a')", [autoId, A]);
    if (entregar) {
      await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,1,'lista')", [autoId, A]);
      if (diasAtras) await admin.query("UPDATE automatizaciones SET entregada = now() - ($2 || ' days')::interval WHERE id=$1", [autoId, diasAtras]);
    } else {
      await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,1,'building')", [autoId, A]);
    }
  };

  try {
    await admin.query("DELETE FROM orgs WHERE id = $1", [A]);
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [A]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [A]); // 20 generaciones
    await seed(NUEVA);                          // entregada hoy → DENTRO
    await seed(VIEJA, { diasAtras: 31 });       // entregada hace 31 días → FUERA
    await seed(SINENTREGA, { entregar: false }); // nunca entregada
    await seed(SELLO);
    await seed(ABUSO);

    console.log("1. La ENTREGA sella la ventana (primera versión lista):");
    check("automatización entregada hoy → dentro de la ventana", (await conOrg(app, A, (c) => estadoDelCiclo(c, NUEVA))).ventanaGratis === true);
    check("entregada hace 31 días → FUERA de la ventana", (await conOrg(app, A, (c) => estadoDelCiclo(c, VIEJA))).ventanaGratis === false);
    check("sin entregar (v1 aún building) → fail-CLOSED: fuera de la ventana", (await conOrg(app, A, (c) => estadoDelCiclo(c, SINENTREGA))).ventanaGratis === false);
    check("la UI recibe la fecha de fin de ventana", typeof (await conOrg(app, A, (c) => estadoDelCiclo(c, NUEVA))).ventanaHasta === "string");

    console.log("\n2. El sello es ÚNICO: una versión posterior NO mueve la fecha:");
    const e1 = await entregaDe(SELLO);
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,2,'lista')", [SELLO, A]);
    check("v2 'lista' no re-sella la entrega (ventana no se extiende)", (await entregaDe(SELLO)) === e1);

    console.log("\n3. DENTRO de la ventana: el cambio NO gasta ajuste, pero SÍ generación:");
    const g0 = await generaciones();
    const d1 = await cambio(NUEVA);
    check("el cambio no consumió ajuste (0 usados, 3 restantes)", d1.ajustesUsados === 0 && d1.ajustesRestantes === 3);
    check("sigue ready (no congela)", d1.estado === "ready");
    check("pero SÍ consumió una generación (tope interno anti-abuso)", (await generaciones()) === g0 + 1);

    console.log("\n4. Ilimitados dentro de la ventana, acotados por el tope interno:");
    for (let i = 0; i < 4; i++) await cambio(ABUSO);
    const ab = await conOrg(app, A, (c) => estadoDelCiclo(c, ABUSO));
    check("4 cambios seguidos en ventana → 0 ajustes usados, sin congelar", ab.ajustesUsados === 0 && ab.estado === "ready");
    check("pero gastaron 4 generaciones (el 'ajustador infinito' queda acotado)", (await generaciones()) === g0 + 5);

    console.log("\n5. FUERA de la ventana: vuelve la regla de los 3 ajustes:");
    const v1 = await cambio(VIEJA), v2 = await cambio(VIEJA), v3 = await cambio(VIEJA);
    check("los 3 cambios consumen ajuste (1,2,3)", v1.ajustesUsados === 1 && v2.ajustesUsados === 2 && v3.ajustesUsados === 3);
    check("el 3º congela (frozen, 0 restantes)", v3.estado === "frozen" && v3.ajustesRestantes === 0);
    check("un 4º cambio → AjusteNoPermitido('frozen')", await (async () => {
      try { await cambio(VIEJA); return false; } catch (e) { return e instanceof AjusteNoPermitido && e.motivo === "frozen"; }
    })());

    console.log("\n6. La ventana NO resucita una automatización ya congelada:");
    await admin.query("UPDATE automatizaciones SET entregada = now() WHERE id = $1", [VIEJA]); // re-entra a la ventana
    check("frozen + dentro de la ventana → el cambio sigue rechazado", await (async () => {
      try { await cambio(VIEJA); return false; } catch (e) { return e instanceof AjusteNoPermitido && e.motivo === "frozen"; }
    })());
    check("y el congelado voluntario también manda sobre la ventana", await (async () => {
      await conOrg(app, A, (c) => congelar(c, NUEVA));
      try { await cambio(NUEVA); return false; } catch (e) { return e instanceof AjusteNoPermitido && e.motivo === "frozen"; }
    })());

    console.log("\n7. El rol de app NO puede falsear el ciclo (antes: ajustes infinitos):");
    check("app UPDATE ajustes_usados → 42501", await codigo(() => conOrg(app, A, (c) => c.query("UPDATE automatizaciones SET ajustes_usados=0 WHERE id=$1", [VIEJA])), "42501"));
    check("app UPDATE ciclo_estado (des-congelarse) → 42501", await codigo(() => conOrg(app, A, (c) => c.query("UPDATE automatizaciones SET ciclo_estado='ready' WHERE id=$1", [VIEJA])), "42501"));
    check("app UPDATE entregada (extender la ventana) → 42501", await codigo(() => conOrg(app, A, (c) => c.query("UPDATE automatizaciones SET entregada=now() WHERE id=$1", [VIEJA])), "42501"));
    check("app SÍ conserva UPDATE de nombre/activa (lo que sí le toca)", await conOrg(app, A, (c) => c.query("UPDATE automatizaciones SET nombre='x' WHERE id=$1", [VIEJA])).then((r) => r.rowCount === 1));

    console.log("\n8. Al CREAR, el app no se autoregala ventana ni contador:");
    const nueva = await conOrg(app, A, (c) => c.query<{ id: string }>(
      "INSERT INTO automatizaciones (org_id,nombre,entregada,ajustes_usados,ciclo_estado) VALUES (app_current_org(),'trampa', now() + interval '365 days', 3, 'frozen') RETURNING id"));
    const nid = nueva.rows[0]!.id;
    const f = await admin.query<{ entregada: string | null; ajustes_usados: number; ciclo_estado: string }>(
      "SELECT entregada, ajustes_usados, ciclo_estado FROM automatizaciones WHERE id=$1", [nid]);
    check("entregada futura ignorada (nace sin entregar)", f.rows[0]?.entregada === null);
    check("contador y estado normalizados (0 / ready)", f.rows[0]?.ajustes_usados === 0 && f.rows[0]?.ciclo_estado === "ready");

    console.log("\n8bis. Hallazgos ALTA de la revisión adversarial:");
    // (a) pg_temp: una TEMP TABLE homónima falseaba TODAS las funciones SECURITY DEFINER.
    check("app no puede crear TEMP TABLEs (REVOKE TEMPORARY)", await codigo(
      () => conOrg(app, A, (c) => c.query("CREATE TEMP TABLE automatizaciones (id uuid)")), "42501"));
    // (b) el 'tipo' ya no lo elige el llamador: se lee de la versión.
    const tipoPersistido = await conOrg(app, A, async (c) => {
      const i = await iniciarAjuste(c, ABUSO, "falla");   // regresión falla → reparación
      const r = await c.query<{ tipo: string }>("SELECT tipo FROM versiones WHERE id=$1", [i.versionId]);
      return r.rows[0]?.tipo;
    });
    check("iniciarAjuste PERSISTE el tipo derivado en la versión", tipoPersistido === "reparacion");
    // (c) el reciclador: borrar y recrear reseteaba contador y ventana.
    check("app no puede BORRAR automatizaciones (anti-reciclador)", await codigo(
      () => conOrg(app, A, (c) => c.query("DELETE FROM automatizaciones WHERE id=$1", [VIEJA])), "42501"));
    check("app no puede borrar versiones (ledger de builds)", await codigo(
      () => conOrg(app, A, (c) => c.query("DELETE FROM versiones WHERE org_id=$1", [A])), "42501"));
    // (d) una org morosa ya no puede ARRANCAR builds (antes gastaba el dinero y fallaba al final).
    await admin.query("UPDATE subscriptions SET estado='morosa' WHERE org_id=$1", [A]);
    check("org MOROSA no puede arrancar un build (se corta antes de gastar)", await (async () => {
      try { await conOrg(app, A, (c) => iniciarAjuste(c, SELLO, "pasa")); return false; } catch { return true; }
    })());
    await admin.query("UPDATE subscriptions SET estado='activa' WHERE org_id=$1", [A]);

    console.log("\n9. La reparación sigue gratis (ni ajuste ni generación), dentro o fuera:");
    const gRep = await generaciones();
    await seed(id(6), { diasAtras: 90 });
    const rep = await conOrg(app, A, async (c) => {
      const i = await iniciarAjuste(c, id(6), "falla");
      return confirmarAjuste(c, id(6), i.versionId);
    });
    check("reparación fuera de la ventana: 0 ajustes usados", rep.ajustesUsados === 0);
    check("y no consumió generación", (await generaciones()) === gRep);
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = $1", [A]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ VENTANA DE 30 DÍAS PROBADA" : "✗ FALLÓ"} — anclada a la entrega, sellada una vez, exime el ajuste pero no la generación, y el app no la puede falsear.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
