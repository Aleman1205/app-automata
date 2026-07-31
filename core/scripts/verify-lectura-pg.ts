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
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,vista,artefacto_key) VALUES ($1,$2,1,'lista',$3::jsonb,'artefactos/a1.json')", [A1, A, vista]);
    await admin.query("INSERT INTO versiones (id,automatizacion_id,org_id,numero,estado) VALUES ('a1000000-0000-0000-0000-0000000000f1',$1,$2,1,'building')", [A2, A]);
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,artefacto_key) VALUES ($1,$2,1,'lista','artefactos/a3.json')", [A3, A]);
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

    // El bug que esto cubre: pedir un cambio insertaba una version nueva en building y el estado
    // pasaba a generando, asi que el front le BLOQUEABA una automatizacion que seguia ejecutable.
    // Y si el ajuste fallaba, quedaba en fallo para siempre. El cliente perdia lo que ya pago.
    console.log(String.fromCharCode(10) + "5. Un ajuste encima NO esconde la automatizacion que ya funciona:");
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,2,'building')", [A1, A]);
    const listar = async () => {
      const r = await conOrg(app, A, (c) => invocar(listarAutomatizacionesEP, c, {}));
      const as = (r.cuerpo as { automatizaciones: Array<{ id: string; estado: string; cambioEnCurso?: boolean }> }).automatizaciones;
      return Object.fromEntries(as.map((a) => [a.id, a]));
    };
    const conAjuste = await listar();
    check("con un cambio EN VUELO sigue lista (usable)", conAjuste[A1]?.estado === "lista");
    check("y avisa que hay un cambio en curso", conAjuste[A1]?.cambioEnCurso === true);
    await admin.query("UPDATE versiones SET estado='failed' WHERE automatizacion_id=$1 AND numero=2", [A1]);
    const conFallo = await listar();
    check("con el ajuste FALLIDO sigue lista (no queda ladrillada)", conFallo[A1]?.estado === "lista");
    check("y ya no reporta cambio en curso", conFallo[A1]?.cambioEnCurso === false);
    await admin.query("DELETE FROM versiones WHERE automatizacion_id=$1 AND numero=2", [A1]);

    // El agujero que esto cubre: /construir solo ENCOLA, así que entre aprobar y el cron el
    // portafolio se veía VACÍO. El cliente concluye que no se guardó y vuelve a aprobar — y eso sí
    // cobra otro build (~$1.8) y otra generación. Ahora lo encolado se muestra como "generando".
    console.log("\n6. Lo aprobado y AÚN EN COLA se ve en el portafolio (si no, se aprueba dos veces):");
    await conOrg(app, A, (c) => c.query("SELECT app_solicitar_build($1,$2,$3)", ["Recién aprobada", JSON.stringify({ objetivo: "x", reglas: [], criterios_exito: ["y"], entradas: [] }), `ejemplos/${A}/x.csv`]));
    const conCola = await conOrg(app, A, (c) => invocar(listarAutomatizacionesEP, c, {}));
    const filas = (conCola.cuerpo as { automatizaciones: Array<{ nombre: string; estado: string; enCola?: boolean }> }).automatizaciones;
    const enCola = filas.find((f) => f.nombre === "Recién aprobada");
    check("aparece en el portafolio antes de que el cron corra", !!enCola);
    check("como 'generando' (el cliente ve que sí quedó)", enCola?.estado === "generando");
    check("marcada enCola (su id es el de la SOLICITUD: el detalle daría 404)", enCola?.enCola === true);
    // Aislamiento: la cola es una tabla de PLATAFORMA sin RLS, así que el scope depende ENTERO de
    // que la SD filtre por app_current_org(). Si se filtrara mal, B vería lo aprobado por A.
    const colaB = await conOrg(app, B, (c) => invocar(listarAutomatizacionesEP, c, {}));
    check("otra org NO ve lo encolado por A (la SD acota por org, no hay RLS que la salve)",
      !(colaB.cuerpo as { automatizaciones: Array<{ nombre: string }> }).automatizaciones.some((f) => f.nombre === "Recién aprobada"));
    await admin.query("DELETE FROM build_pendiente WHERE org_id = $1", [A]);

    // `reintentable` decide si el front pinta el botón de "Reintentar sin costo". Tiene que decir
    // que sí SOLO cuando app_solicitar_reintento lo va a aceptar: un botón que responde 409 al clic
    // es la misma promesa rota que el toast que reemplazó. La primera prueba por HTTP cazó que le
    // faltaba `activa`.
    console.log("\n7. `reintentable` coincide con lo que la SD va a aceptar:");
    const R1 = "0aaaaaaa-0000-4000-8000-00000000ee01";
    const reint = async (id: string): Promise<boolean> => {
      const r = await conOrg(app, A, (c) => invocar(listarAutomatizacionesEP, c, {}));
      const f = (r.cuerpo as { automatizaciones: Array<{ id: string; reintentable?: boolean }> }).automatizaciones.find((x) => x.id === id);
      return f?.reintentable === true;
    };
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre,spec,ejemplo_key) VALUES ($1,$2,'Falló',$3,$4)", [R1, A, JSON.stringify({ objetivo: "x", reglas: [], criterios_exito: ["y"], entradas: [] }), `ejemplos/${A}/x.csv`]);
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,1,'failed')", [R1, A]);
    check("fallida, nunca entregada, con insumos → sí", await reint(R1));
    await admin.query("UPDATE automatizaciones SET activa=false WHERE id=$1", [R1]);
    check("INACTIVA (downgrade) → no (la SD respondería 409 'inactiva')", !(await reint(R1)));
    await admin.query("UPDATE automatizaciones SET activa=true, ejemplo_key=NULL WHERE id=$1", [R1]);
    check("sin ejemplo guardado → no (no hay con qué reconstruir)", !(await reint(R1)));
    await admin.query("UPDATE automatizaciones SET ejemplo_key=$2 WHERE id=$1", [R1, `ejemplos/${A}/x.csv`]);
    await admin.query("UPDATE versiones SET estado='lista' WHERE automatizacion_id=$1", [R1]); // sella entregada
    check("ya entregada → no (rehacerlo gratis regalaría un cambio)", !(await reint(R1)));
  } finally {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ API DE LECTURA PROBADA" : "✗ FALLÓ"} — listar/detalle bajo RLS: ve solo su org, deriva el estado, trae vista+versiones, y el cross-org da 404.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
