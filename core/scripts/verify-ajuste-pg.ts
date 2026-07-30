// ─────────────────────────────────────────────────────────────────────────────
// Verificación del ARRANQUE DE AJUSTE (la pieza que faltaba del ciclo) contra Postgres, con
// cosechador/storage FALSOS (sin CMA ni R2 ni modelo). Antes de este módulo NADIE abría una sesión
// de CMA para una versión > 1: arrancarConstruccion crea una automatización NUEVA con `numero: 1`.
// Prueba: (1) un CAMBIO crea la versión siguiente 'building' con su cma_session_id y le pasa al
// agente el código vigente + la petición; (2) el tipo lo DERIVA la regresión, no el llamador;
// (3) una REPARACIÓN no gasta ajuste; (4) si CMA falla al arrancar, la versión queda 'failed' y NO
// deja trabado el "un build en vuelo"; (5) los 3 ajustes topan y el 4º se rechaza.
//   ADMIN_URL=... DATABASE_URL=... npm run verify:ajuste:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { arrancarAjuste, drenarAjustes, type AjusteDeps } from "../src/pipeline/ajuste.ts";
import { estadoDelCiclo, AjusteNoPermitido } from "../src/ciclo/servicio.ts";
import type { ArranqueBuild, BuildClientAsync, PeticionAjuste, ResultadoCosecha, Spec, Storage } from "../src/types.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const O = "0aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaf";
const EJEMPLO = `ejemplos/${O}/original.csv`;
const CODIGO_VIEJO = "import sys\nprint('version vigente')\n";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

const spec: Spec = {
  objetivo: "Sumar ventas por vendedor",
  reglas: ["Agrupar por vendedor"],
  criterios_exito: ["El total coincide con la suma del archivo (± 0.01)"],
  entradas: [{ tipo: "archivo", formato: "csv", descripcion: "CSV vendedor,monto" }],
};

class FakeStorage implements Storage {
  async put() {}
  async existe() { return true; }
  async list() { return []; }
  async get() { return Buffer.from("vendedor,monto\nAna,100\n"); } // el ejemplo original
  async getText() { return JSON.stringify({ automatizacionPy: CODIGO_VIEJO, manifiesto: { entradas: [] }, vista: {} }); }
}
// Captura lo que se le manda a CMA: es la prueba de que el agente recibe la petición y el código
// vigente (sin eso reinventaría la automatización y le cambiaría al cliente lo que ya aprobó).
class FakeCosechador implements BuildClientAsync {
  n = 0;
  ultimoAjuste?: PeticionAjuste;
  fallar = false;
  async build(): Promise<never> { throw new Error("no usado"); }
  async cosechar(): Promise<ResultadoCosecha> { return { estado: "en_curso" }; }
  async arrancar(_s: Spec, _p: string, _c?: string, ajuste?: PeticionAjuste): Promise<ArranqueBuild> {
    this.ultimoAjuste = ajuste;
    if (this.fallar) throw new Error("CMA caído");
    return { sessionId: `sess_ajuste_${++this.n}` };
  }
}

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const uno = (sql: string, p: unknown[] = []) => admin.query<Record<string, unknown>>(sql, p).then((r) => r.rows[0]);
  const cosechador = new FakeCosechador();
  const deps: AjusteDeps = { pool: app, cosechador, storage: new FakeStorage(), ahora: () => new Date().toISOString() };

  // Automatización ENTREGADA (v1 'lista'): el punto de partida de cualquier ajuste.
  const sembrar = async (): Promise<string> => {
    const a = await uno("INSERT INTO automatizaciones (org_id, nombre) VALUES ($1,'Reporte de ventas') RETURNING id", [O]);
    const id = a!["id"] as string;
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,1,'lista')", [id, O]);
    return id;
  };
  const args = (id: string, peticion: string, regresion: "pasa" | "falla" | "indeterminado") => ({
    orgId: O, automatizacionId: id, peticion, spec, ejemploKey: EJEMPLO, regresion,
  });

  try {
    await admin.query("DELETE FROM orgs WHERE id=$1", [O]);
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'Ajustes')", [O]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [O]);

    console.log("1. Un CAMBIO arranca la versión SIGUIENTE (no una automatización nueva):");
    const id1 = await sembrar();
    const r1 = await arrancarAjuste(deps, args(id1, "Además quiero el promedio por venta", "pasa"));
    check("el tipo lo derivó la regresión: 'pasa' → cambio", r1.tipo === "cambio");
    check(`creó la versión 2 (numero=${r1.numero})`, r1.numero === 2);
    const v2 = await uno("SELECT estado, cma_session_id AS sid, tipo FROM versiones WHERE id=$1", [r1.versionId]);
    check("quedó 'building' con su cma_session_id (el webhook la encontrará)", v2?.["estado"] === "building" && !!v2?.["sid"]);
    check("persistió tipo='cambio' (la BD decide el cobro con eso)", v2?.["tipo"] === "cambio");
    check("NO creó otra automatización", (await uno("SELECT count(*)::int AS n FROM automatizaciones WHERE org_id=$1", [O]))?.["n"] === 1);
    check("resolver_sesion_cma la mapea", !!(await uno("SELECT version_id FROM resolver_sesion_cma($1)", [r1.sessionId])));

    console.log("\n2. El agente recibe la PETICIÓN y el CÓDIGO VIGENTE (para modificar, no reinventar):");
    check("le llegó la petición del cliente", cosechador.ultimoAjuste?.peticion === "Además quiero el promedio por venta");
    check("le llegó el código de la versión vigente", cosechador.ultimoAjuste?.codigoAnterior === CODIGO_VIEJO);
    check("le llegó el número de versión (sabe que es revisión)", cosechador.ultimoAjuste?.numeroVersion === 2);

    console.log("\n3. Una REPARACIÓN ('falla') no gasta ajuste:");
    const id3 = await sembrar();
    const antes3 = await conOrg(app, O, (c) => estadoDelCiclo(c, id3));
    const r3 = await arrancarAjuste(deps, args(id3, "Dejó de salir el total", "falla"));
    check("la regresión 'falla' → reparacion", r3.tipo === "reparacion");
    const desp3 = await conOrg(app, O, (c) => estadoDelCiclo(c, id3));
    check(`no consumió ajuste al arrancar (${antes3.ajustesUsados}→${desp3.ajustesUsados})`, desp3.ajustesUsados === antes3.ajustesUsados);
    check("persistió tipo='reparacion'", (await uno("SELECT tipo FROM versiones WHERE id=$1", [r3.versionId]))?.["tipo"] === "reparacion");

    console.log("\n4. Si CMA falla al arrancar, la versión NO queda trabada en 'building':");
    const id4 = await sembrar();
    cosechador.fallar = true;
    let lanzo = false;
    try { await arrancarAjuste(deps, args(id4, "otro cambio", "pasa")); } catch { lanzo = true; }
    cosechador.fallar = false;
    check("propagó el error al llamador", lanzo);
    const trabadas = await uno("SELECT count(*)::int AS n FROM versiones WHERE automatizacion_id=$1 AND estado='building'", [id4]);
    check("no dejó ninguna versión 'building' (sin esto, no se podría pedir otro ajuste nunca)", trabadas?.["n"] === 0);
    // Con la anterior marcada 'failed', el guard de "un build en vuelo" ya no bloquea.
    const r4 = await arrancarAjuste(deps, args(id4, "reintento", "pasa"));
    check("y se puede pedir otro ajuste de inmediato", r4.numero === 3);

    console.log("\n5. El tope de 3 ajustes se respeta (el 4º se rechaza):");
    const id5 = await sembrar();
    await admin.query("UPDATE automatizaciones SET ajustes_usados = 3, ciclo_estado = 'frozen' WHERE id = $1", [id5]);
    let motivo = "";
    try { await arrancarAjuste(deps, args(id5, "uno más", "pasa")); }
    catch (e) { motivo = e instanceof AjusteNoPermitido ? e.motivo : `otro: ${(e as Error).message}`; }
    check(`rechaza con AjusteNoPermitido('frozen') (fue: ${motivo})`, motivo === "frozen");
    check("una REPARACIÓN sí se permite aunque esté frozen (mantenerla viva es obligación)",
      (await arrancarAjuste(deps, args(id5, "se rompió", "falla"))).tipo === "reparacion");

    // El camino REAL de producción: el request solo encola (app_solicitar_ajuste) y el drainer hace
    // el trabajo caro. Antes esto no existía: no había cola ni forma de llegar a arrancarAjuste.
    console.log("\n6. Cola + drainer (el camino que usa el endpoint):");
    const id6 = await sembrar();
    await admin.query("UPDATE automatizaciones SET spec=$2, ejemplo_key=$3 WHERE id=$1",
      [id6, JSON.stringify(spec), EJEMPLO]);
    const enc = await conOrg(app, O, (c) => c.query<{ id: string }>("SELECT app_solicitar_ajuste($1,$2) AS id", [id6, "Agrega el promedio"]));
    check("app_solicitar_ajuste encoló", !!enc.rows[0]?.id);
    check("el app NO puede escribir la cola directo (REVOKE ALL)", await (async () => {
      try { await conOrg(app, O, (c) => c.query("INSERT INTO ajuste_pendiente (org_id, automatizacion_id, peticion) VALUES (app_current_org(),$1,x)", [id6])); return false; } catch { return true; }
    })());
    check("dos clics no encolan dos veces (UNIQUE por automatización)",
      (await conOrg(app, O, (c) => c.query<{ id: string }>("SELECT app_solicitar_ajuste($1,$2) AS id", [id6, "otra vez"]))).rows[0]?.id === enc.rows[0]?.id);
    const dr = await drenarAjustes({ ...deps, poolOwner: admin, notificador: { async notificar() {} } });
    check(`el drainer lo arrancó (arrancados=${dr.arrancados})`, dr.arrancados === 1);
    check("y lo sacó de la cola", (await uno("SELECT count(*)::int AS n FROM ajuste_pendiente WHERE automatizacion_id=$1", [id6]))?.["n"] === 0);
    check("dejó la versión 2 building con sesión de CMA", !!(await uno("SELECT cma_session_id FROM versiones WHERE automatizacion_id=$1 AND numero=2", [id6]))?.["cma_session_id"]);

    console.log("\n7. Una automatización SIN spec/ejemplo guardados no se puede ajustar (se avisa, no se finge):");
    const id7 = await sembrar(); // sin spec ni ejemplo_key
    await conOrg(app, O, (c) => c.query("SELECT app_solicitar_ajuste($1,$2) AS id", [id7, "cambio"]));
    const avisos: string[] = [];
    let r7 = { arrancados: 0, fallidos: 0, pendientes: 0 };
    for (let i = 0; i < 3; i++) r7 = await drenarAjustes({ ...deps, poolOwner: admin, notificador: { async notificar(e) { avisos.push(e.tipo); } } });
    check("se descarta tras los intentos", r7.fallidos === 1);
    check("y se le avisa al cliente (no se queda esperando)", avisos.length === 1 && avisos[0] === "fallo");
  } finally {
    await admin.query("DELETE FROM orgs WHERE id=$1", [O]).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ AJUSTE PROBADO" : "✗ FALLÓ"} — el ciclo puede construir versiones >1: reserva, arranca CMA con el código vigente + la petición, y libera el "en vuelo" si el arranque falla.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
