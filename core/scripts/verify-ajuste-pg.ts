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
import type { ArranqueBuild, BuildClientAsync, PeticionAjuste, ResultadoCosecha, Spec, Storage, Vista } from "../src/types.ts";
import type { AjustePlan, PlanResultado } from "../src/planner/schema.ts";

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

const VISTA_V1: Vista = {
  version_vista: 1, titulo: "Ventas por vendedor", archivoSalida: "reporte.xlsx",
  bloques: [{ tipo: "resumen", texto: "Así van las ventas" }],
};
const VISTA_V2: Vista = {
  version_vista: 1, titulo: "Ventas por vendedor", archivoSalida: "reporte.xlsx",
  bloques: [{ tipo: "resumen", texto: "Así van las ventas, ahora con promedio" }],
};

// El planner FALSO (sin modelo). Captura lo que se le pide: es la prueba de que el ajuste SÍ
// replanea con la petición del cliente, en vez de entregar una versión sin vista (que se cobraba
// y luego reventaba al ejecutarse) o con la vista vieja (el cliente pide columnas nuevas y recibe
// el reporte de antes).
class FakePlaneador {
  visto?: AjustePlan;
  async planear(_spec: Spec, ajuste?: AjustePlan): Promise<PlanResultado> {
    this.visto = ajuste;
    return {
      vista: ajuste ? VISTA_V2 : VISTA_V1,
      resultado_contrato: { campos: [{ ruta: "total", tipo: "numero", descripcion: "total" }] },
    };
  }
}

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
  ultimoContrato?: string;
  fallar = false;
  async build(): Promise<never> { throw new Error("no usado"); }
  async cosechar(): Promise<ResultadoCosecha> { return { estado: "en_curso" }; }
  async arrancar(_s: Spec, _p: string, contrato?: string, ajuste?: PeticionAjuste): Promise<ArranqueBuild> {
    this.ultimoAjuste = ajuste;
    this.ultimoContrato = contrato;
    if (this.fallar) throw new Error("CMA caído");
    return { sessionId: `sess_ajuste_${++this.n}` };
  }
}

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const uno = (sql: string, p: unknown[] = []) => admin.query<Record<string, unknown>>(sql, p).then((r) => r.rows[0]);
  const cosechador = new FakeCosechador();
  const planeador = new FakePlaneador();
  const deps: AjusteDeps = { pool: app, cosechador, storage: new FakeStorage(), ahora: () => new Date().toISOString() };

  // Automatización ENTREGADA (v1 'lista'): el punto de partida de cualquier ajuste.
  const sembrar = async (): Promise<string> => {
    const a = await uno("INSERT INTO automatizaciones (org_id, nombre) VALUES ($1,'Reporte de ventas') RETURNING id", [O]);
    const id = a!["id"] as string;
    // La v1 se siembra CON vista, como la crea el build real: es lo que el planner del ajuste
    // recibe para evolucionarla en vez de reinventar el reporte que el cliente ya reconoce.
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado, vista) VALUES ($1,$2,1,'lista',$3)", [id, O, JSON.stringify(VISTA_V1)]);
    return id;
  };
  const args = (id: string, peticion: string, regresion: "pasa" | "falla" | "indeterminado") => ({
    orgId: O, automatizacionId: id, peticion, spec, ejemploKey: EJEMPLO, regresion, vista: VISTA_V2,
  });

  try {
    await admin.query("DELETE FROM orgs WHERE id=$1", [O]);
    // drenarAjustes drena la cola COMPLETA (es global): una fila de otra org —dejada por otro test o
    // encolada a mano en dev— la levantaria este test con su cosechador falso y desviaria los
    // conteos. Se vacia para que la corrida sea determinista, igual que en verify:disparo:pg.
    await admin.query("DELETE FROM ajuste_pendiente");
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'Ajustes')", [O]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [O]);

    console.log("1. Un CAMBIO arranca la versión SIGUIENTE (no una automatización nueva):");
    const id1 = await sembrar();
    const r1 = await arrancarAjuste(deps, args(id1, "Además quiero el promedio por venta", "pasa"));
    check("el tipo lo derivó la regresión: 'pasa' → cambio", r1.tipo === "cambio");
    check(`creó la versión 2 (numero=${r1.numero})`, r1.numero === 2);
    const v2 = await uno("SELECT estado, cma_session_id AS sid, tipo, vista FROM versiones WHERE id=$1", [r1.versionId]);
    check("quedó 'building' con su cma_session_id (el webhook la encontrará)", v2?.["estado"] === "building" && !!v2?.["sid"]);
    check("persistió tipo='cambio' (la BD decide el cobro con eso)", v2?.["tipo"] === "cambio");
    // El bug que encontró el primer ajuste real: la versión nacía SIN vista, se entregaba 'lista'
    // (cobrada) y al ejecutarla tronaba con "Cannot read properties of undefined (reading 'bloques')".
    check("nació CON vista (sin ella la versión se cobra y no se puede ejecutar)", !!v2?.["vista"]);
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
    const dr = await drenarAjustes({ ...deps, poolOwner: admin, planeador, notificador: { async notificar() {} } });
    check(`el drainer lo arrancó (arrancados=${dr.arrancados})`, dr.arrancados === 1);
    check("y lo sacó de la cola", (await uno("SELECT count(*)::int AS n FROM ajuste_pendiente WHERE automatizacion_id=$1", [id6]))?.["n"] === 0);
    check("dejó la versión 2 building con sesión de CMA", !!(await uno("SELECT cma_session_id FROM versiones WHERE automatizacion_id=$1 AND numero=2", [id6]))?.["cma_session_id"]);

    // ── El agujero que encontró el PRIMER AJUSTE REAL (con dinero) ──
    // El drainer construía el código pero NUNCA llamaba al planner, así que la v2 quedaba sin vista
    // ni contrato: se entregaba 'lista', ya cobrada, y al ejecutarla tronaba. El test no lo veía
    // porque solo miraba estado y sesión — las dos cosas que sí estaban bien.
    console.log("\n6bis. El ajuste REPLANEA la vista (el cliente pide otra cosa, no lo mismo):");
    check("el drainer llamó al planner con la petición del cliente", planeador.visto?.peticion === "Agrega el promedio");
    check("y le pasó la vista VIGENTE (la evoluciona, no reinventa el reporte)",
      (planeador.visto?.vistaAnterior as Vista | undefined)?.titulo === VISTA_V1.titulo);
    const v2r = await uno("SELECT vista FROM versiones WHERE automatizacion_id=$1 AND numero=2", [id6]);
    check("la versión nueva quedó CON vista", !!v2r?.["vista"]);
    // Se compara el CONTENIDO que distingue a las dos vistas, no el JSON completo: jsonb normaliza
    // el orden de las llaves, así que stringify() nunca coincide aunque la vista sea la correcta.
    const bloqueV2 = (v2r?.["vista"] as Vista | null)?.bloques?.[0];
    check("y es la NUEVA, no la copia de la v1 (si no, el cambio pedido no se vería)",
      bloqueV2?.tipo === "resumen" && bloqueV2.texto === (VISTA_V2.bloques[0] as { texto: string }).texto);
    check("al agente le llegó el CONTRATO del resultado (sin él, las refs @resultado.* no resuelven)",
      !!cosechador.ultimoContrato && cosechador.ultimoContrato.includes("campos"));

    // No se puede COBRAR un "cambio" de algo que el cliente nunca recibió: si el primer build falló,
    // no existe versión vigente contra la cual comparar, así que la regresión ni siquiera aplica.
    // Antes salía 'indeterminado' → cambio → le facturaba una generación encima del build fallido.
    console.log("\n6ter. Un ajuste sobre algo NUNCA ENTREGADO es reparación (gratis), no cambio:");
    // NO se usa sembrar(): ese deja la v1 'lista', y pasar por 'lista' sella `entregada` para
    // siempre (trg_marcar_entrega) — marcarla 'failed' después NO la des-entrega. Hay que nacerla
    // fallida, que es justo el caso real: el primer build tronó y el cliente nunca recibió nada.
    const id6b = (await uno("INSERT INTO automatizaciones (org_id, nombre, spec, ejemplo_key) VALUES ($1,'Nunca entregada',$2,$3) RETURNING id", [O, JSON.stringify(spec), EJEMPLO]))!["id"] as string;
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,1,'failed')", [id6b, O]);
    check("la automatización no tiene fecha de entrega", !(await uno("SELECT entregada FROM automatizaciones WHERE id=$1", [id6b]))?.["entregada"]);
    await conOrg(app, O, (c) => c.query("SELECT app_solicitar_ajuste($1,$2)", [id6b, "reconstruye esto"]));
    await drenarAjustes({ ...deps, poolOwner: admin, planeador, notificador: { async notificar() {} } });
    const vNueva = await uno("SELECT tipo FROM versiones WHERE automatizacion_id=$1 AND estado='building'", [id6b]);
    check("se clasifica como reparacion (no le cobra un cambio de lo que nunca recibió)", vNueva?.["tipo"] === "reparacion");
    check("y NO consumió ajuste", (await conOrg(app, O, (c) => estadoDelCiclo(c, id6b))).ajustesUsados === 0);

    // REINTENTAR un build fallido. Es GRATIS, así que lo que hay que probar no es el camino feliz
    // sino las guardas: quién NO puede reintentar. Sin ellas, "reintentar" sería la puerta trasera
    // para conseguir cambios sin gastar ninguno de los 3.
    console.log("\n8. Reintentar un build fallido: gratis, pero acotado:");
    const reintentar = async (auto: string): Promise<string> => {
      try {
        await conOrg(app, O, (c) => c.query("SELECT app_solicitar_reintento($1)", [auto]));
        return "ok";
      } catch (e) { return /REINTENTO_NO_PERMITIDO:(\w+)/.exec((e as Error).message)?.[1] ?? `otro: ${(e as Error).message}`; }
    };
    // (a) nunca entregada + última versión fallida + con insumos → SÍ
    const id8 = (await uno("INSERT INTO automatizaciones (org_id, nombre, spec, ejemplo_key) VALUES ($1,'Falló al construir',$2,$3) RETURNING id", [O, JSON.stringify(spec), EJEMPLO]))!["id"] as string;
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,1,'failed')", [id8, O]);
    check("un build fallido SÍ se puede reintentar", (await reintentar(id8)) === "ok");
    check("dos clics no encolan dos veces", (await reintentar(id8)) === "ok" && (await uno("SELECT count(*)::int AS n FROM ajuste_pendiente WHERE automatizacion_id=$1", [id8]))?.["n"] === 1);

    // (b) el drainer lo reconstruye SIN cobrar y le dice al agente que empiece de cero.
    await drenarAjustes({ ...deps, poolOwner: admin, planeador, notificador: { async notificar() {} } });
    const v8 = await uno("SELECT numero, estado, tipo, (vista IS NOT NULL) AS vista FROM versiones WHERE automatizacion_id=$1 AND estado='building'", [id8]);
    check("arranca la versión siguiente, con vista", v8?.["numero"] === 2 && !!v8?.["vista"]);
    check("como reparacion → NO le cobra otra generación por el build que falló", v8?.["tipo"] === "reparacion");
    check("al agente se le dice RECONSTRUIR (no 'parte del código vigente', que no existe)",
      cosechador.ultimoAjuste?.reconstruccion === true && !cosechador.ultimoAjuste?.codigoAnterior);

    // (c) las guardas: cada una tapa una forma de sacar builds gratis o de romperse.
    const idEntregada = await sembrar(); // v1 'lista' ⇒ entregada quedó sellada
    await admin.query("UPDATE automatizaciones SET spec=$2, ejemplo_key=$3 WHERE id=$1", [idEntregada, JSON.stringify(spec), EJEMPLO]);
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado, tipo) VALUES ($1,$2,2,'failed','cambio')", [idEntregada, O]);
    check("YA ENTREGADA con un cambio fallido → NO (gratis le regalaría un ajuste de sus 3)", (await reintentar(idEntregada)) === "ya_entregada");
    const idSinInsumos = (await uno("INSERT INTO automatizaciones (org_id, nombre) VALUES ($1,'Sin insumos') RETURNING id", [O]))!["id"] as string;
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,1,'failed')", [idSinInsumos, O]);
    check("SIN spec/ejemplo → NO (no hay con qué reconstruir)", (await reintentar(idSinInsumos)) === "sin_insumos");
    const idViva = (await uno("INSERT INTO automatizaciones (org_id, nombre, spec, ejemplo_key) VALUES ($1,'Construyendo',$2,$3) RETURNING id", [O, JSON.stringify(spec), EJEMPLO]))!["id"] as string;
    await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,1,'building')", [idViva, O]);
    check("con un build EN VUELO → NO (no se reintenta lo que sigue corriendo)", (await reintentar(idViva)) === "no_fallida");
    check("de OTRA org → NO existe (RLS/scope de la SD)", (await (async () => {
      const ajena = (await uno("INSERT INTO orgs (id,nombre) VALUES (gen_random_uuid(),'Otra') RETURNING id"))!["id"] as string;
      const a = (await uno("INSERT INTO automatizaciones (org_id, nombre, spec, ejemplo_key) VALUES ($1,'Ajena',$2,$3) RETURNING id", [ajena, JSON.stringify(spec), EJEMPLO]))!["id"] as string;
      await admin.query("INSERT INTO versiones (automatizacion_id, org_id, numero, estado) VALUES ($1,$2,1,'failed')", [a, ajena]);
      const r = await reintentar(a);
      await admin.query("DELETE FROM orgs WHERE id=$1", [ajena]);
      return r;
    })()) === "no_existe");
    await admin.query("DELETE FROM ajuste_pendiente");

    console.log("\n7. Una automatización SIN spec/ejemplo guardados no se puede ajustar (se avisa, no se finge):");
    const id7 = await sembrar(); // sin spec ni ejemplo_key
    await conOrg(app, O, (c) => c.query("SELECT app_solicitar_ajuste($1,$2) AS id", [id7, "cambio"]));
    const avisos: string[] = [];
    let r7 = { arrancados: 0, fallidos: 0, pendientes: 0 };
    for (let i = 0; i < 3; i++) r7 = await drenarAjustes({ ...deps, poolOwner: admin, planeador, notificador: { async notificar(e) { avisos.push(e.tipo); } } });
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
