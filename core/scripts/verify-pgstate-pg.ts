// ─────────────────────────────────────────────────────────────────────────────
// Verificación del PgStateRepo: conecta las DOS mitades del motor que hasta ahora se
// probaban por separado — el PIPELINE (build→artefacto→run→vista) y el ENFORCEMENT de
// la BD (RLS, cuota, kill-switch, ventana, ciclo). Corre el pipeline M0 REAL contra
// Postgres (con stubs de build/run/storage, sin CMA ni Python) bajo el rol de app, y
// afirma que los triggers disparan de verdad: v1 cobra generación, sella la entrega, el
// kill-switch frena, la cuota corta, RLS aísla.
//   ADMIN_URL=... DATABASE_URL=... npm run verify:pgstate:pg
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crearPool } from "../src/db/pg.ts";
import { PgStateRepo } from "../src/state/pg.ts";
import { construir, ejecutar, type Deps } from "../src/pipeline/build-pipeline.ts";
import { CuotaExcedida } from "../src/billing/cuota.ts";
import { ServicioSuspendido, congelar, descongelar } from "../src/ops/killswitch.ts";
import type { BuildClient, RunExecutor, Storage, Spec, Vista } from "../src/types.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const D = "dddddddd-dddd-dddd-dddd-dddddddddddd";
// El período se le PREGUNTA A LA BD, no se calcula en JS.
// Antes era `new Date().toISOString().slice(0,7)`, o sea el mes en **UTC**, mientras que quien
// cobra de verdad —`cobrar_build`/`app_consumir`— usa `to_char(now(),'YYYY-MM')`, o sea la hora
// **LOCAL** del servidor. Con la máquina en CST (-06:00) los dos coinciden 18 horas al día y
// divergen las otras 6: el último día del mes, a partir de las 18:00 locales, UTC ya está en el
// mes siguiente. Este test sembraba la cuota agotada en un mes y el trigger cobraba en otro, así
// que el tope no mordía y el verify fallaba sin que nada del producto estuviera roto.
// Pasó de verdad: verde a mediodía, rojo a las 18:52 del 31 de julio.
// Convertir la zona horaria en JS solo movería el problema — sería una SEGUNDA implementación de
// la misma regla, libre de volver a separarse. Preguntando a la BD coinciden por construcción.
const PER = async (p: { query: (q: string) => Promise<{ rows: Array<{ p: string }> }> }): Promise<string> =>
  (await p.query("SELECT to_char(now(),'YYYY-MM') AS p")).rows[0]!.p;
// a4: el gate de entrada ahora corre en construir/ejecutar, así que se usa un archivo REAL
// válido (no '/dev/null' ni inputs:{}, que el gate rechazaría por 'vacio' antes de los asserts).
let MUESTRA: string;

let admin: ReturnType<typeof crearPool>;
let app: ReturnType<typeof crearPool>;
let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const genDe = (org: string) => admin.query<{ n: number }>("SELECT coalesce(sum(generaciones),0)::int AS n FROM uso_periodo WHERE org_id=$1", [org]).then((r) => r.rows[0]?.n ?? 0);
const lanza = async (fn: () => Promise<unknown>, clase: new (...a: never[]) => Error) => {
  try { await fn(); return false; } catch (e) { return e instanceof clase; }
};

// ── Stubs de los puertos externos (sin CMA, sin Python, sin R2) ──
class StubStorage implements Storage {
  private m = new Map<string, string>();
  async put(k: string, d: Buffer | string) { this.m.set(k, typeof d === "string" ? d : d.toString("utf8")); }
  async get(k: string) { return Buffer.from(this.m.get(k) ?? ""); }
  async getText(k: string) { const v = this.m.get(k); if (v === undefined) throw new Error(`sin clave: ${k}`); return v; }
  async existe(k: string) { return this.m.has(k); }
  async list(p: string) { return [...this.m.keys()].filter((k) => k.startsWith(p)); }
}
const stubBuild: BuildClient = {
  async build() { return { codigo: { automatizacionPy: "print('ok')", manifiesto: { entradas: [] } }, costoUsd: 0, iteraciones: 1, aprobado: true }; },
};
const stubRun: RunExecutor = { async run() { return { resultado: {}, ms: 42, costoUsd: 0, salidas: [] }; } };
const spec: Spec = { objetivo: "demo", reglas: [], criterios_exito: [], entradas: [] };
const vista: Vista = { version_vista: 1, titulo: "demo", archivoSalida: "out.json", bloques: [] };
const depsDe = (org: string): Deps => ({ storage: new StubStorage(), state: new PgStateRepo(app, org), build: stubBuild, run: stubRun, ahora: () => new Date().toISOString() });

async function main() {
  admin = crearPool(ADMIN_URL);
  app = crearPool(APP_URL);
  MUESTRA = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pgstate-")), "muestra.csv");
  await fs.writeFile(MUESTRA, "producto,ingreso\nTaco,100\nAgua,20\n");
  const repoA = new PgStateRepo(app, A);
  const repoB = new PgStateRepo(app, B);
  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B, C, D]]);
    await admin.query("UPDATE interruptores SET builds=false, ejecuciones=false, cobros=false");
    for (const [o, plan] of [[A, "equipo"], [B, "equipo"], [C, "base"]] as const) {
      await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [o]);
      await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,$2)", [o, plan]);
    }
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'sin-sub')", [D]); // D: SIN subscription

    console.log("1. Métodos directos del repo bajo el rol de app (RLS + enforcement):");
    const g0 = await genDe(A);
    const auto = await repoA.crearAutomatizacion({ orgId: A, nombre: "Reporte" });
    check("crearAutomatizacion → fila con orgId correcto", auto.orgId === A && typeof auto.id === "string");
    const ver = await repoA.crearVersion({ automatizacionId: auto.id, numero: 1, estado: "building", creada: "x" });
    check("crearVersion (build inicial) → estado building", ver.estado === "building");
    check("...y COBRÓ una generación al arrancar (cobrar_build)", (await genDe(A)) === g0 + 1);
    const lista = await repoA.actualizarVersion(ver.id, { estado: "ready", artefactoKey: "artefactos/x.json" });
    check("actualizarVersion(ready, artefactoKey) → persiste ambos", lista.estado === "ready" && lista.artefactoKey === "artefactos/x.json");
    const sellada = (await admin.query<{ e: string | null }>("SELECT entregada::text AS e FROM automatizaciones WHERE id=$1", [auto.id])).rows[0]?.e;
    check("el paso a ready SELLÓ la entrega (trg_marcar_entrega)", sellada !== null && sellada !== undefined);
    check("obtenerVersion la trae", (await repoA.obtenerVersion(ver.id))?.id === ver.id);

    console.log("\n2. RLS: el repo de otra org NO ve la versión ajena:");
    check("repoB.obtenerVersion(versión de A) → undefined", (await repoB.obtenerVersion(ver.id)) === undefined);
    check("repoB.actualizarVersion(versión de A) → no encontrada (RLS)", await lanza(() => repoB.actualizarVersion(ver.id, { estado: "failed" }), Error));

    console.log("\n3. Reserva→confirma del run (crearEjecucion → actualizarEjecucion):");
    const ej = await repoA.crearEjecucion({ versionId: ver.id, estado: "reservada", ms: 0, costoUsd: 0, creada: "x" });
    check("crearEjecucion → reservada", ej.estado === "reservada");
    const ejOk = await repoA.actualizarEjecucion(ej.id, { estado: "ok", ms: 42, costoUsd: 0 });
    check("actualizarEjecucion → ok, ms persistido", ejOk.estado === "ok" && ejOk.ms === 42);

    console.log("\n4. El kill-switch frena el build A TRAVÉS del repo:");
    await congelar(admin, "builds");
    check("crearVersion con builds congelados → ServicioSuspendido", await lanza(() => repoA.crearVersion({ automatizacionId: auto.id, numero: 2, estado: "building", creada: "x" }), ServicioSuspendido));
    await descongelar(admin, "builds");

    console.log("\n5. La cuota corta el build A TRAVÉS del repo (plan base = 6 gen):");
    const autoC = await new PgStateRepo(app, C).crearAutomatizacion({ orgId: C, nombre: "c" });
    await admin.query("INSERT INTO uso_periodo (org_id,periodo,generaciones) VALUES ($1,$2,6) ON CONFLICT (org_id,periodo) DO UPDATE SET generaciones=6", [C, await PER(admin)]);
    check("crearVersion con generaciones agotadas → CuotaExcedida", await lanza(() => new PgStateRepo(app, C).crearVersion({ automatizacionId: autoC.id, numero: 1, estado: "building", creada: "x" }), CuotaExcedida));

    console.log("\n6. Org SIN subscription no puede crear (integridad):");
    check("crearAutomatizacion sin subscription → lanza", await lanza(() => new PgStateRepo(app, D).crearAutomatizacion({ orgId: D, nombre: "d" }), Error));

    console.log("\n7. PIPELINE M0 completo contra Postgres (build→artefacto→run→vista):");
    const gA = await genDe(A);
    const depsA = depsDe(A); // MISMO storage entre construir y ejecutar
    const { version } = await construir(depsA, { orgId: A, nombre: "Pipeline PG", spec, vista, ejemploPath: MUESTRA });
    check("construir → versión ready con artefacto", version.estado === "ready" && !!version.artefactoKey);
    check("el pipeline consumió una generación de verdad", (await genDe(A)) === gA + 1);
    const filaV = (await admin.query<{ estado: string; tipo: string | null }>("SELECT estado, tipo FROM versiones WHERE id=$1", [version.id])).rows[0];
    check("la versión existe en Postgres, estado ready, tipo NULL (build inicial)", filaV?.estado === "ready" && filaV?.tipo === null);
    const { ejecucion } = await ejecutar(depsA, { version, inputs: { archivo: MUESTRA } });
    check("ejecutar → ejecución ok persistida en Postgres", ejecucion.estado === "ok");
    const filaE = (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM ejecuciones WHERE version_id=$1 AND estado='ok'", [version.id])).rows[0]?.n;
    check("la ejecución quedó en el ledger (reserva→confirma, 1 fila ok)", filaE === 1);

    console.log("\n8. El pipeline respeta el kill-switch Y COMPENSA la automatización huérfana:");
    const activasAntes = (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id=$1 AND activa", [A])).rows[0]?.n ?? 0;
    await congelar(admin, "builds");
    check("construir con builds congelados → ServicioSuspendido", await lanza(() => construir(depsDe(A), { orgId: A, nombre: "bloqueada", spec, vista, ejemploPath: MUESTRA }), ServicioSuspendido));
    await descongelar(admin, "builds");
    const activasDespues = (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id=$1 AND activa", [A])).rows[0]?.n ?? 0;
    check("NO dejó automatización huérfana activa (compensación: activa=false)", activasDespues === activasAntes);

    console.log("\n9. Hallazgos de la revisión aplicados:");
    // (a) crearAutomatizacion no escribe en el tenant equivocado (repo mal-vinculado).
    check("crearAutomatizacion({orgId: B}) en un repo ligado a A → lanza (mismatch)", await lanza(() => repoA.crearAutomatizacion({ orgId: B, nombre: "trampa" }), Error));
    // (b) el tope de ejecuciones se aplica en el camino real (trg cobrar_ejecucion).
    await admin.query("INSERT INTO uso_periodo (org_id,periodo,ejecuciones) VALUES ($1,$2,10000) ON CONFLICT (org_id,periodo) DO UPDATE SET ejecuciones=10000", [A, await PER(admin)]);
    check("crearEjecucion con ejecuciones agotadas → CuotaExcedida", await lanza(() => repoA.crearEjecucion({ versionId: ver.id, estado: "reservada", ms: 0, costoUsd: 0, creada: "x" }), CuotaExcedida));
    await admin.query("UPDATE uso_periodo SET ejecuciones=0 WHERE org_id=$1", [A]);
    // (c) ejecutar recomputa la clave: aunque artefacto_key esté tampereado, corre igual.
    const dA2 = depsDe(A);
    const built = await construir(dA2, { orgId: A, nombre: "recompute", spec, vista, ejemploPath: MUESTRA });
    await admin.query("UPDATE versiones SET artefacto_key='artefactos/AJENO.json' WHERE id=$1", [built.version.id]);
    const tampered = { ...built.version, artefactoKey: "artefactos/AJENO.json" };
    check("ejecutar ignora artefacto_key tampereado (recomputa de version.id)", (await ejecutar(dA2, { version: tampered, inputs: { archivo: MUESTRA } })).ejecucion.estado === "ok");
  } finally {
    await admin.query("UPDATE interruptores SET builds=false, ejecuciones=false, cobros=false").catch(() => {});
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B, C, D]]).catch(() => {});
    await admin.end();
    await app.end();
  }

  console.log(`\n${ok ? "✓ PgStateRepo PROBADO" : "✗ FALLÓ"} — el pipeline corre contra Postgres bajo el rol de app; los triggers (cuota, kill-switch, entrega) disparan de verdad y RLS aísla.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
