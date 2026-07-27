// ─────────────────────────────────────────────────────────────────────────────
// Verificación de la API de LECTURA (GET listar/detalle) contra Postgres. Corre los HANDLERS
// bajo conOrg (rol de app, RLS): confirma que (1) listar ve SOLO las de la org, (2) el estado
// derivado (lista/generando/congelada) es correcto, (3) el detalle trae versiones + vista, y
// (4) pedir el detalle de OTRA org → 404 (RLS: 0 filas). La autz (acción "ver", ambos roles)
// la cubre verify:http; aquí se prueba la query + el aislamiento.
//   ADMIN_URL=... DATABASE_URL=... npm run verify:lectura:pg
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool, conOrg } from "../src/db/pg.ts";
import { listarAutomatizacionesEP, verAutomatizacionEP } from "../src/http/endpoints.ts";
import type { PoolClient } from "pg";
import type { Contexto, Respuesta } from "../src/http/tipos.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const A1 = "a1000000-0000-0000-0000-0000000000a1"; // lista
const A2 = "a2000000-0000-0000-0000-0000000000a2"; // building → generando
const A3 = "a3000000-0000-0000-0000-0000000000a3"; // frozen → congelada
const B1 = "b1000000-0000-0000-0000-0000000000b1"; // de otra org

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
// Invoca un handler de endpoint con un Contexto mínimo (solo usa cliente+input).
const invocar = <T>(ep: { handler: (c: Contexto<T>) => Promise<Respuesta> }, c: PoolClient, input: T): Promise<Respuesta> =>
  ep.handler({ cliente: c, input, orgId: A, identidad: { userId: "u" }, membresia: { orgId: A, userId: "u", rol: "operador" } });

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const vista = JSON.stringify({ version_vista: 1, titulo: "Reporte", archivoSalida: "out.json", bloques: [] });
  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]);
    for (const o of [A, B]) { await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'o')", [o]); await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo')", [o]); }
    // A: 3 automatizaciones con estados distintos.
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'Lista'),($3,$2,'Generando'),($4,$2,'Congelada')", [A1, A, A2, A3]);
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,vista) VALUES ($1,$2,1,'lista',$3::jsonb)", [A1, A, vista]);
    await admin.query("INSERT INTO versiones (id,automatizacion_id,org_id,numero,estado) VALUES ('a1000000-0000-0000-0000-0000000000f1',$1,$2,1,'building')", [A2, A]);
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,1,'lista')", [A3, A]);
    await admin.query("UPDATE automatizaciones SET ciclo_estado='frozen' WHERE id=$1", [A3]); // congelada
    // 2 ejecuciones sobre A1.
    const verA1 = (await admin.query<{ id: string }>("SELECT id FROM versiones WHERE automatizacion_id=$1 LIMIT 1", [A1])).rows[0]!.id;
    await admin.query("INSERT INTO ejecuciones (version_id,org_id,estado,ms) VALUES ($1,$2,'ok',100),($1,$2,'ok',120)", [verA1, A]);
    // B: una automatización ajena.
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'Ajena')", [B1, B]);
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,1,'lista')", [B1, B]);

    console.log("1. listar: ve SOLO las de la org, con estado derivado + conteo de ejecuciones:");
    const lista = await conOrg(app, A, (c) => invocar(listarAutomatizacionesEP, c, {}));
    const autos = (lista.cuerpo as { automatizaciones: Array<{ id: string; nombre: string; estado: string; ejecuciones: number }> }).automatizaciones;
    check("devuelve exactamente las 3 de A (ninguna de B)", autos.length === 3 && autos.every((a) => a.id !== B1));
    const byId = Object.fromEntries(autos.map((a) => [a.id, a]));
    check("estado 'lista' (versión lista, ciclo ready)", byId[A1]?.estado === "lista");
    check("estado 'generando' (versión building)", byId[A2]?.estado === "generando");
    check("estado 'congelada' (ciclo frozen)", byId[A3]?.estado === "congelada");
    check("cuenta las ejecuciones de A1 (2)", byId[A1]?.ejecuciones === 2);

    console.log("\n2. detalle: versiones + vista de la última lista:");
    const det = await conOrg(app, A, (c) => invocar(verAutomatizacionEP, c, { id: A1 }));
    const d = det.cuerpo as { estado: string; versiones: unknown[]; vista: { titulo: string } | null };
    check("status 200", det.status === 200);
    check("trae la vista (layout) de la versión lista", d.vista?.titulo === "Reporte");
    check("trae el historial de versiones", Array.isArray(d.versiones) && d.versiones.length === 1);

    console.log("\n3. aislamiento: el detalle de OTRA org → 404 (RLS: 0 filas):");
    const ajena = await conOrg(app, A, (c) => invocar(verAutomatizacionEP, c, { id: B1 }));
    check("pedir la automatización de B desde A → 404", ajena.status === 404);
    const listaB = await conOrg(app, B, (c) => invocar(listarAutomatizacionesEP, c, {}));
    check("listar como B ve solo la suya (1)", (listaB.cuerpo as { automatizaciones: unknown[] }).automatizaciones.length === 1);
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ API DE LECTURA PROBADA" : "✗ FALLÓ"} — listar/detalle bajo RLS: ve solo su org, deriva el estado, trae vista+versiones, y el cross-org da 404.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
