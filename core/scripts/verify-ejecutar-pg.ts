// ─────────────────────────────────────────────────────────────────────────────
// Verificación del RUN de punta a punta contra Postgres, SIN credenciales: inyecta
// LocalStorage + LocalPythonExecutor (corre Python de verdad) + el Postgres temporal.
// Prueba que ejecutarAutomatizacion (pipeline/run.ts) hace el loop real:
//   FRENO → resolver versión ejecutable (RLS) → reserva (cobra cuota + kill-switch) →
//   correr el artefacto (código puro) → resolver la vista → confirmar 'ok'.
// Y los cortes: kill-switch congela ANTES de gastar, sin versión → 404, cross-org bloqueado.
//   ADMIN_URL=... DATABASE_URL=... npm run verify:ejecutar:pg
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crearPool, conOrg } from "../src/db/pg.ts";
import { ejecutarAutomatizacion, SinVersionEjecutable } from "../src/pipeline/run.ts";
import { listarEjecucionesEP } from "../src/http/endpoints.ts";
import { LocalStorage } from "../src/storage/local.ts";
import { LocalPythonExecutor } from "../src/run/executor.ts";
import type { Artefacto, Vista } from "../src/types.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const APP_URL = process.env.DATABASE_URL ?? "postgres://automata_app@127.0.0.1:55432/postgres";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AUTO_A = "a1000000-0000-0000-0000-0000000000a1"; // A, con versión ready + artefacto
const AUTO_A_SIN = "a2000000-0000-0000-0000-0000000000a2"; // A, solo 'building' (sin ejecutable)
const AUTO_B = "b1000000-0000-0000-0000-0000000000b1"; // B (para el cross-org)

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const lanza = async (fn: () => Promise<unknown>): Promise<unknown> => { try { await fn(); return null; } catch (e) { return e; } };

// Artefacto fixture: un script que ignora su insumo y escribe resultado.json = {total:42};
// la vista referencia @resultado.total, así el resolver debe aterrizar 42.
const PY = [
  "import sys, json, os",
  "salida = sys.argv[sys.argv.index('--salida') + 1]",
  "os.makedirs(salida, exist_ok=True)",
  "open(os.path.join(salida, 'resultado.json'), 'w').write(json.dumps({'total': 42}))",
].join("\n");
const VISTA: Vista = {
  version_vista: 1, titulo: "Reporte", archivoSalida: "resultado.json",
  bloques: [{ tipo: "metricas", items: [{ etiqueta: "Total", valor: "@resultado.total", formato: "entero" }] }],
};
const ARTEFACTO: Artefacto = {
  automatizacionPy: PY,
  manifiesto: { entradas: [{ nombre: "datos", tipo: "archivo", formato: "csv", descripcion: "insumo", requerido: true }] },
  vista: VISTA,
};

async function main() {
  const admin = crearPool(ADMIN_URL);
  const app = crearPool(APP_URL);
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), "automata-verify-run-"));
  const storage = new LocalStorage(raiz);
  const run = new LocalPythonExecutor(); // NODE_ENV != production → sin guard
  const deps = { pool: app, storage, run, ahora: () => new Date().toISOString() };
  // Insumo benigno (.csv de texto → pasa el gate).
  const inputPath = path.join(raiz, "datos.csv");
  await fs.writeFile(inputPath, "a,b\n1,2\n");
  const inputs = { "datos.csv": inputPath };
  const metas = { "datos.csv": { extension: "csv" } };
  // Cuenta las ejecuciones (reservas) de una automatización, vía admin (bypassa RLS).
  const cuenta = async (auto: string): Promise<number> =>
    Number((await admin.query("SELECT count(*)::int AS n FROM ejecuciones e JOIN versiones v ON e.version_id=v.id WHERE v.automatizacion_id=$1", [auto])).rows[0].n);

  try {
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]);
    await admin.query("UPDATE interruptores SET ejecuciones = false"); // arranca abierto
    await admin.query("INSERT INTO orgs (id,nombre) VALUES ($1,'A'),($2,'B')", [A, B]);
    await admin.query("INSERT INTO subscriptions (org_id,plan) VALUES ($1,'equipo'),($2,'equipo')", [A, B]);
    await admin.query("INSERT INTO automatizaciones (id,org_id,nombre) VALUES ($1,$2,'Reporte A'),($3,$2,'Sin build'),($4,$5,'De B')", [AUTO_A, A, AUTO_A_SIN, AUTO_B, B]);
    // AUTO_A: versión ready CON artefacto. artefacto_key debe ser NON-NULL (el WHERE lo exige);
    // el loader RECOMPUTA la clave de version.id, así que escribimos el fixture ahí.
    const verA = (await admin.query<{ id: string }>("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,artefacto_key) VALUES ($1,$2,1,'ready','pendiente') RETURNING id", [AUTO_A, A])).rows[0]!.id;
    await storage.put(`artefactos/${verA}.json`, JSON.stringify(ARTEFACTO));
    // AUTO_A_SIN: solo 'building', sin artefacto → no ejecutable. AUTO_B: ready con artefacto.
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,1,'building')", [AUTO_A_SIN, A]);
    const verB = (await admin.query<{ id: string }>("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,artefacto_key) VALUES ($1,$2,1,'ready','pendiente') RETURNING id", [AUTO_B, B])).rows[0]!.id;
    await storage.put(`artefactos/${verB}.json`, JSON.stringify(ARTEFACTO));

    console.log("1. Happy path: corre el artefacto, resuelve la vista y confirma la ejecución:");
    const res = await ejecutarAutomatizacion(deps, { orgId: A, automatizacionId: AUTO_A, inputs, metas });
    const bloque = res.resultado.bloques[0];
    const valor = bloque?.tipo === "metricas" ? bloque.items[0]?.valor : undefined;
    check("la vista se aterriza sobre los datos del run (@resultado.total → 42)", valor === 42);
    check("la ejecución quedó 'ok'", res.ejecucion.estado === "ok");
    check("reporta ms (número) y costo local $0", typeof res.ms === "number" && res.ejecucion.costoUsd === 0);

    console.log("\n2. La reserva cobró la cuota (uso_periodo del mes) y dejó el asiento:");
    const uso = Number((await admin.query("SELECT ejecuciones FROM uso_periodo WHERE org_id=$1 AND periodo=to_char(now(),'YYYY-MM')", [A])).rows[0]?.ejecuciones ?? 0);
    check("uso_periodo.ejecuciones = 1 (cobrar_ejecucion en la reserva)", uso === 1);
    check("hay 1 fila de ejecuciones para AUTO_A", (await cuenta(AUTO_A)) === 1);

    console.log("\n2b. Persistencia: la corrida deja resultado_key + bytes en storage + historial:");
    const rk = (await admin.query<{ resultado_key: string | null }>("SELECT resultado_key FROM ejecuciones WHERE id=$1", [res.ejecucion.id])).rows[0]?.resultado_key;
    check("la ejecución quedó con resultado_key", !!rk);
    check("el Resultado está en storage (descargable)", await storage.existe(`resultados/${res.ejecucion.id}.json`));
    const hist = await conOrg(app, A, (c) => listarEjecucionesEP.handler({ cliente: c, input: { id: AUTO_A }, orgId: A, identidad: { userId: "u" }, membresia: { orgId: A, userId: "u", rol: "operador" } }));
    const ejs = (hist.cuerpo as { ejecuciones: Array<{ id: string; tieneResultado: boolean }> }).ejecuciones;
    check("el historial lista la corrida con tieneResultado=true", ejs.some((e) => e.id === res.ejecucion.id && e.tieneResultado));

    console.log("\n3. Kill-switch: ejecuciones congeladas → aborta ANTES de gastar (sin cobro):");
    await admin.query("UPDATE interruptores SET ejecuciones = true");
    const antes = await cuenta(AUTO_A);
    const eCongelado = await lanza(() => ejecutarAutomatizacion(deps, { orgId: A, automatizacionId: AUTO_A, inputs, metas }));
    check("el run lanza con el freno puesto", eCongelado !== null);
    check("NO se creó una nueva ejecución (el freno mordió antes de la reserva)", (await cuenta(AUTO_A)) === antes);
    await admin.query("UPDATE interruptores SET ejecuciones = false"); // restaurar

    console.log("\n4. Sin versión ejecutable → SinVersionEjecutable (y sin cobro):");
    const eSin = await lanza(() => ejecutarAutomatizacion(deps, { orgId: A, automatizacionId: AUTO_A_SIN, inputs, metas }));
    check("AUTO_A_SIN (solo 'building') → SinVersionEjecutable", eSin instanceof SinVersionEjecutable);
    check("no se cobró nada por AUTO_A_SIN", (await cuenta(AUTO_A_SIN)) === 0);

    console.log("\n5. Aislamiento: A intenta correr una automatización de B → bloqueado por RLS:");
    const eCross = await lanza(() => ejecutarAutomatizacion(deps, { orgId: A, automatizacionId: AUTO_B, inputs, metas }));
    check("correr AUTO_B desde A → SinVersionEjecutable (RLS la esconde)", eCross instanceof SinVersionEjecutable);
    check("no se cobró nada de B por el intento cross-org", (await cuenta(AUTO_B)) === 0);

    console.log("\n6. Solo-lectura tras un downgrade: activa=false NO se puede ejecutar:");
    // Sección nueva (auditoría por mutación, Parte 2). El `AND a.activa` del WHERE no lo ejercía
    // ningún check: quitarlo pasaba la suite entera. Y no hace falta atacante — es el usuario
    // honesto: al bajar de Equipo ($1,999, 10 espacios) a Base ($499, 3), aplicarDowngrade deja el
    // excedente en activa=false, pero la tarjeta sigue en el portafolio con su botón Ejecutar.
    // Sin esta línea, el cliente sigue usando lo que dejó de pagar.
    await admin.query("UPDATE automatizaciones SET activa = false WHERE id = $1", [AUTO_A]);
    const antesInactiva = await cuenta(AUTO_A);
    const eInactiva = await lanza(() => ejecutarAutomatizacion(deps, { orgId: A, automatizacionId: AUTO_A, inputs, metas }));
    check("automatización en solo-lectura → SinVersionEjecutable", eInactiva instanceof SinVersionEjecutable);
    check("no se cobró la ejecución de una automatización inactiva", (await cuenta(AUTO_A)) === antesInactiva);
    await admin.query("UPDATE automatizaciones SET activa = true WHERE id = $1", [AUTO_A]); // restaurar

    console.log("\n7. Con varias versiones entregadas, corre la VIGENTE (la más reciente):");
    // La otra mitad del mismo WHERE: `ORDER BY v.numero DESC`. Con ASC, quien pagó un ajuste
    // recibiría para siempre el reporte VIEJO con datos frescos — sin excepción, sin 500, y con la
    // UI diciendo "lista". Resultado incorrecto SILENCIOSO, el peor modo de falla que hay.
    // Se distinguen por el valor que produce cada artefacto (42 la v1, 99 la v2): comprobar el
    // `numero` no bastaría, porque lo que le llega al cliente es el resultado, no el número.
    const ART_V2: Artefacto = { ...ARTEFACTO, automatizacionPy: PY.replace("'total': 42", "'total': 99") };
    const verA2 = (await admin.query<{ id: string }>("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,artefacto_key) VALUES ($1,$2,2,'lista','pendiente') RETURNING id", [AUTO_A, A])).rows[0]!.id;
    await storage.put(`artefactos/${verA2}.json`, JSON.stringify(ART_V2));
    const resV2 = await ejecutarAutomatizacion(deps, { orgId: A, automatizacionId: AUTO_A, inputs, metas });
    const bloqueV2 = resV2.resultado.bloques[0];
    const valorV2 = bloqueV2?.tipo === "metricas" ? bloqueV2.items[0]?.valor : undefined;
    check("corrió la v2 y no la v1 (el resultado trae 99, no 42)", valorV2 === 99);
    check("la ejecución quedó atada a la versión vigente", resV2.ejecucion.versionId === verA2);
  } finally {
    await admin.query("UPDATE interruptores SET ejecuciones = false").catch(() => {});
    await admin.query("DELETE FROM orgs WHERE id = ANY($1)", [[A, B]]).catch(() => {});
    await fs.rm(raiz, { recursive: true, force: true }).catch(() => {});
    await admin.end(); await app.end();
  }
  console.log(`\n${ok ? "✓ RUN PROBADO DE PUNTA A PUNTA" : "✗ FALLÓ"} — corre código real, resuelve la vista, cobra en la reserva, y corta por freno / sin-versión / cross-org.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
