// ─────────────────────────────────────────────────────────────────────────────
// Verificación del DISPARO de build (a3-s6) contra Postgres, con planner/cosechador/storage
// FALSOS (sin modelo ni CMA ni R2). Prueba: el app encola SOLO vía el SD app_solicitar_build
// (no INSERT directo); y drenarBuilds corre el planner + arrancarConstruccion (crea la
// automatización + versión 'building' con vista + cma_session_id) y saca la solicitud.
//   ADMIN_URL=... DATABASE_URL=... npm run verify:disparo:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { drenarBuilds, type DisparoDeps, type Planeador } from "../src/pipeline/disparo.ts";
import type { ArranqueBuild, BuildClientAsync, ResultadoCosecha, Storage, Vista } from "../src/types.ts";
import type { PlanResultado } from "../src/planner/schema.ts";
import type { EventoCorreo } from "../src/ops/notificaciones.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const vista: Vista = { version_vista: 1, titulo: "demo", archivoSalida: "out.json", bloques: [] };
const plan: PlanResultado = { vista, resultado_contrato: { campos: [] } as unknown as PlanResultado["resultado_contrato"] };

class FakeStorage implements Storage {
  async put() {} async getText() { return ""; } async existe() { return true; } async list() { return []; }
  async get() { return Buffer.from("producto,ingreso\nTaco,100\n"); } // el ejemplo que baja el drainer
}
class FakePlaneador implements Planeador {
  llamado = 0;
  async planear() { this.llamado++; return plan; }
}
class FakeCosechador implements BuildClientAsync {
  n = 0;
  async build(): Promise<never> { throw new Error("no usado"); }
  async cosechar(): Promise<ResultadoCosecha> { return { estado: "en_curso" }; }
  // Un id por arranque: con uno fijo, dos arranques en la misma corrida chocaban contra el
  // UNIQUE de versiones.cma_session_id y el fallo se leía como un bug del drainer.
  async arrancar(): Promise<ArranqueBuild> { return { sessionId: `sess_disparo_${++this.n}` }; }
}

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const uno = (sql: string, p: unknown[] = []) => admin.query<Record<string, unknown>>(sql, p).then((r) => r.rows[0]);
  const codigoDe = async (fn: () => Promise<unknown>) => { try { await fn(); return "permitido"; } catch (e) { return (e as { code?: string }).code ?? "throw"; } };
  const deps: DisparoDeps = { pool: admin, planeador: new FakePlaneador(), cosechador: new FakeCosechador(), storage: new FakeStorage(), ahora: () => new Date().toISOString() };

  try {
    await admin.query("DELETE FROM orgs WHERE id=$1", [A]);
    // drenarBuilds drena el outbox COMPLETO (es global, corre con el pool dueño), así que una
    // solicitud de otra org —p.ej. una encolada a mano en el modo dev— la levantaría este test
    // con su planner falso y desviaría los conteos. Se vacía para que la corrida sea determinista.
    await admin.query("DELETE FROM build_pendiente");
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [A]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [A]);

    console.log("1. El app encola SOLO vía el SD (no INSERT directo):");
    check("INSERT directo en build_pendiente como app → 42501", (await conOrg(app, A, (c) => codigoDe(() => c.query("INSERT INTO build_pendiente (org_id,nombre,spec,ejemplo_key) VALUES (app_current_org(),'x','{}','k')")))) === "42501");
    const spec = JSON.stringify({ objetivo: "reporte", reglas: [], criterios_exito: ["ok"], entradas: [] });
    await conOrg(app, A, (c) => c.query("SELECT app_solicitar_build('Reporte X', $1::jsonb, 'ejemplos/" + A + "/m.csv')", [spec]));
    check("app_solicitar_build encoló la solicitud con org_id=A", (await uno("SELECT count(*)::int AS n FROM build_pendiente WHERE org_id=$1 AND nombre='Reporte X'", [A]))?.["n"] === 1);

    console.log("\n2. drenarBuilds: planner + arrancarConstruccion (crea versión building + cma_session_id):");
    const res = await drenarBuilds(deps);
    check(`arrancó la solicitud (arrancados=${res.arrancados})`, res.arrancados === 1);
    check("corrió el planner", (deps.planeador as FakePlaneador).llamado === 1);
    check("sacó la solicitud del outbox", (await uno("SELECT count(*)::int AS n FROM build_pendiente WHERE org_id=$1", [A]))?.["n"] === 0);
    const auto = await uno("SELECT id FROM automatizaciones WHERE org_id=$1 AND nombre='Reporte X'", [A]);
    check("creó la automatización", !!auto);
    const ver = await uno("SELECT estado, cma_session_id AS sid, (vista IS NOT NULL) AS v FROM versiones WHERE automatizacion_id=$1", [auto?.["id"]]);
    check("creó la versión 'building' con cma_session_id + vista", ver?.["estado"] === "building" && ver?.["sid"] === "sess_disparo_1" && ver?.["v"] === true);
    check("resolver_sesion_cma la mapea (el webhook la encontrará)", !!(await uno("SELECT version_id FROM resolver_sesion_cma('sess_disparo_1')")));

    console.log("\n3. Outbox vacío → no-op:");
    check("drenarBuilds sobre outbox vacío → 0", (await drenarBuilds(deps)).arrancados === 0);

    // Un build que se descarta tras agotar intentos NO puede quedar en silencio: el cliente ya vio
    // "ya está construyendo, te avisamos por correo" y la automatización nunca se creó, así que su
    // portafolio ni la muestra. Sin este aviso, se queda esperando algo que no va a llegar.
    console.log("\n4. Descarte tras MAX_INTENTOS: incidente para ops + AVISO al cliente:");
    const avisos: EventoCorreo[] = [];
    const depsFalla: DisparoDeps = {
      ...deps,
      planeador: { async planear() { throw new Error("planner caído (p.ej. llave inválida)"); } },
      notificador: { async notificar(e) { avisos.push(e); } },
    };
    await conOrg(app, A, (c) => c.query("SELECT app_solicitar_build('Reporte Que Falla', $1::jsonb, 'ejemplos/" + A + "/m.csv')", [spec]));
    // Cada corrida = 1 intento real por fila (si el drainer gastara 2, el descarte llegaría antes
    // de las 3 y este conteo lo delataría).
    let fallidos = 0, corridas = 0;
    for (let i = 0; i < 5; i++) {
      const r = await drenarBuilds(depsFalla);
      fallidos += r.fallidos;
      corridas++;
      if (r.fallidos > 0) break;
    }
    check(`se descartó tras 3 intentos, no antes (corridas=${corridas})`, fallidos === 1 && corridas === 3);
    check("sacó la solicitud del outbox (no cuelga el drenado)", (await uno("SELECT count(*)::int AS n FROM build_pendiente WHERE org_id=$1", [A]))?.["n"] === 0);
    check("registró incidente para operaciones", ((await uno("SELECT count(*)::int AS n FROM incidentes WHERE org_id=$1", [A]))?.["n"] as number) >= 1);
    check(`avisó al cliente UNA vez (avisos=${avisos.length})`, avisos.length === 1);
    check("el aviso es de tipo 'fallo' y trae el nombre de la solicitud", avisos[0]?.tipo === "fallo" && avisos[0]?.nombre === "Reporte Que Falla");
    check("el aviso NO trae automatizacionId (nunca se creó)", avisos[0]?.automatizacionId === undefined);
    check("no creó automatización huérfana", (await uno("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id=$1 AND nombre='Reporte Que Falla'", [A]))?.["n"] === 0);

    // El bug de dinero: el lock del claim muere con el UPDATE (autocommit) y el trabajo caro corre
    // fuera, asi que dos crons solapados reclamaban la MISMA fila y construian —y COBRABAN— el
    // mismo build dos veces (~1.8 USD cada uno). Se prueba con dos drainers EN PARALELO.
    console.log(String.fromCharCode(10) + "5. Dos drainers solapados NO construyen el mismo build dos veces:");
    await admin.query("DELETE FROM build_pendiente");
    await conOrg(app, A, (c) => c.query("SELECT app_solicitar_build($1, $2::jsonb, $3)", ["Una sola vez", spec, "ejemplos/" + A + "/m.csv"]));
    const lento = new FakePlaneador();
    lento.planear = async () => { await new Promise((r) => setTimeout(r, 400)); return plan; }; // build lento
    const solapado = new FakeCosechador();
    solapado.arrancar = async () => ({ sessionId: `sess_solape_${++solapado.n}` }); // prefijo propio: no choca con los de arriba
    const depsLento: DisparoDeps = { ...deps, planeador: lento, cosechador: solapado };
    const [d1, d2] = await Promise.all([drenarBuilds(depsLento), drenarBuilds(depsLento)]);
    const total = d1.arrancados + d2.arrancados;
    check("solo UNO de los dos lo arranco (arrancados=" + total + ")", total === 1);
    check("y existe UNA sola automatizacion con ese nombre (no dos cobros)",
      (await uno("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id=$1 AND nombre=$2", [A, "Una sola vez"]))?.["n"] === 1);
  } finally {
    await admin.query("DELETE FROM build_pendiente WHERE org_id=$1", [A]).catch(() => {});
    await admin.query("DELETE FROM incidentes WHERE org_id=$1", [A]).catch(() => {});
    await admin.query("DELETE FROM orgs WHERE id=$1", [A]).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ DISPARO PROBADO" : "✗ FALLÓ"} — el endpoint encola vía SD (app no toca la tabla); el drainer corre planner + arrancarConstruccion fuera del request.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
