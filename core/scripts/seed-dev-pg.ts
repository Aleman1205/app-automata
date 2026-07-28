// ─────────────────────────────────────────────────────────────────────────────
// Siembra del MODO DEV LOCAL: crea una org + equipo + automatizaciones (estados variados) y
// —para la(s) 'lista'— escribe un ARTEFACTO EJECUTABLE real al storage local, de modo que el
// endpoint de Run pueda correrlas de verdad (archivo → resultado) sin credenciales. Idempotente.
// Corre con el pool DUEÑO. Los ids/rutas DEBEN coincidir con web/lib/automata/dev.ts y el env
// AUTOMATA_DEV_STORAGE_DIR del front.
//   ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres npm run seed:dev
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crearPool } from "../src/db/pg.ts";
import { LocalStorage } from "../src/storage/local.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const AQUI = path.dirname(fileURLToPath(import.meta.url)); // core/scripts
const STORAGE_DIR = process.env.AUTOMATA_DEV_STORAGE_DIR ?? path.resolve(AQUI, "..", "..", ".dev-storage");
const ORG = "0de00000-0000-0000-0000-0000000de000"; // = DEV_ORG
const USER = "u_dev"; // = DEV_USER
const A1 = "0de00000-0000-0000-0000-0000000000a1"; // lista + EJECUTABLE
const A2 = "0de00000-0000-0000-0000-0000000000a2"; // generando (sin artefacto)
const A3 = "0de00000-0000-0000-0000-0000000000a3"; // congelada + EJECUTABLE

// Vista del reporte: resumen + métrica total + ranking por vendedor (referencias @resultado.*).
const VISTA = {
  version_vista: 1,
  titulo: "Reporte mensual de ventas",
  archivoSalida: "resultado.json",
  bloques: [
    { tipo: "resumen", texto: "@resultado.resumen" },
    { tipo: "metricas", items: [{ etiqueta: "Ventas totales", valor: "@resultado.total", formato: "moneda" }] },
    { tipo: "ranking", titulo: "Ventas por vendedor", formato: "moneda", fuente: "@resultado.por_vendedor", eje_x: "etiqueta", eje_y: "valor" },
  ],
};

// El artefacto: script Python que agrega un CSV (vendedor,monto) → resultado.json. Código puro,
// SIN modelo (es el Run). Corre en el LocalPythonExecutor.
const PY = [
  "import sys, json, os, csv",
  "from collections import defaultdict",
  "inp = sys.argv[1]",
  "salida = sys.argv[sys.argv.index('--salida') + 1]",
  "os.makedirs(salida, exist_ok=True)",
  "tot = defaultdict(float)",
  "with open(inp, newline='', encoding='utf-8-sig') as fh:",
  "    for row in csv.DictReader(fh):",
  "        try:",
  "            tot[(row.get('vendedor') or '(sin nombre)').strip()] += float(row.get('monto') or 0)",
  "        except (ValueError, TypeError):",
  "            pass",
  "por = sorted([{'etiqueta': k, 'valor': round(v, 2)} for k, v in tot.items()], key=lambda x: -x['valor'])",
  "total = round(sum(x['valor'] for x in por), 2)",
  "res = {'resumen': f'Procesamos {len(por)} vendedores por un total de ${total:,.0f} en el periodo.', 'total': total, 'por_vendedor': por}",
  "with open(os.path.join(salida, 'resultado.json'), 'w', encoding='utf-8') as fh:",
  "    json.dump(res, fh, ensure_ascii=False)",
].join("\n");

const ARTEFACTO = JSON.stringify({
  automatizacionPy: PY,
  manifiesto: { entradas: [{ nombre: "ventas", tipo: "archivo", formato: "csv", descripcion: "Tu archivo de ventas (columnas: vendedor, monto)", requerido: true }] },
  vista: VISTA,
});

async function main() {
  const admin = crearPool(ADMIN_URL);
  const storage = new LocalStorage(STORAGE_DIR);
  await fs.rm(path.join(STORAGE_DIR, "artefactos"), { recursive: true, force: true }); // evita artefactos viejos de re-siembras
  try {
    await admin.query("DELETE FROM orgs WHERE id = $1", [ORG]); // idempotente (CASCADE limpia todo)
    await admin.query("INSERT INTO orgs (id, nombre) VALUES ($1, 'Hotel Vitrales (dev)')", [ORG]);
    await admin.query("INSERT INTO subscriptions (org_id, plan) VALUES ($1, 'equipo')", [ORG]);
    await admin.query(
      "INSERT INTO memberships (org_id, user_id, rol) VALUES ($1,$2,'admin'),($1,'u_luis','operador'),($1,'u_carmen','operador')",
      [ORG, USER],
    );
    await admin.query(
      "INSERT INTO automatizaciones (id, org_id, nombre) VALUES ($1,$2,'Reporte mensual de ventas'),($3,$2,'Conciliación de facturas'),($4,$2,'Resumen de reservaciones')",
      [A1, ORG, A2, A3],
    );

    // Escribe una versión LISTA con artefacto EJECUTABLE (artefacto_key + bytes en storage) y
    // devuelve su id. El Run recomputa la clave de version.id, así que el artefacto va ahí.
    const sembrarEjecutable = async (auto: string): Promise<string> => {
      const id = (await admin.query<{ id: string }>(
        "INSERT INTO versiones (automatizacion_id,org_id,numero,estado,vista) VALUES ($1,$2,1,'lista',$3::jsonb) RETURNING id",
        [auto, ORG, JSON.stringify(VISTA)],
      )).rows[0]!.id;
      await storage.put(`artefactos/${id}.json`, ARTEFACTO);
      await admin.query("UPDATE versiones SET artefacto_key = $2 WHERE id = $1", [id, `artefactos/${id}.json`]);
      return id;
    };

    const v1 = await sembrarEjecutable(A1); // lista, ejecutable
    await admin.query("INSERT INTO ejecuciones (version_id,org_id,estado,ms,costo_usd) VALUES ($1,$2,'ok',1240,0),($1,$2,'ok',980,0)", [v1, ORG]);
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,1,'building')", [A2, ORG]); // generando
    await sembrarEjecutable(A3); // lista + ejecutable...
    await admin.query("UPDATE automatizaciones SET ciclo_estado='frozen' WHERE id=$1", [A3]); // ...pero congelada
    await admin.query("INSERT INTO uso_periodo (org_id,periodo,generaciones,ejecuciones) VALUES ($1, to_char(now(),'YYYY-MM'), 3, 2) ON CONFLICT (org_id,periodo) DO UPDATE SET generaciones=3, ejecuciones=2", [ORG]);

    console.log("✓ Sembrado el modo dev (con artefactos ejecutables):");
    console.log(`  org      ${ORG}  (plan equipo)`);
    console.log(`  usuario  ${USER}  (admin) + Luis, Carmen (operadores)`);
    console.log("  3 automatizaciones: 'lista' (EJECUTABLE, 2 ejecuciones), 'generando', 'congelada' (EJECUTABLE)");
    console.log(`  storage  ${STORAGE_DIR}  (artefactos/*.json)`);
    console.log("\nEn web/.env.local: AUTOMATA_DEV_AUTH=1, DATABASE_URL=…55432, APP_ORIGIN=http://localhost:3000,");
    console.log(`  NEXT_PUBLIC_AUTOMATA_DEV_ORG=${ORG}, AUTOMATA_DEV_STORAGE_DIR=${STORAGE_DIR}`);
  } finally {
    await admin.end();
  }
}
main().catch((e) => { console.error("Error sembrando:", e); process.exit(1); });
