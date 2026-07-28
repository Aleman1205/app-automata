// ─────────────────────────────────────────────────────────────────────────────
// Siembra del MODO DEV LOCAL: crea una org + equipo + automatizaciones (estados variados)
// para que el front local (AUTOMATA_DEV_AUTH=1) muestre datos REALES desde el backend real
// (RLS, cuota, Run), sin credenciales. Idempotente: borra la org DEV y la recrea. Corre con el
// pool DUEÑO (bypassa RLS/triggers para sembrar). Los ids DEBEN coincidir con web/lib/automata/dev.ts.
//   ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres npm run seed:dev
// ─────────────────────────────────────────────────────────────────────────────
import { crearPool } from "../src/db/pg.ts";

const ADMIN_URL = process.env.ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const ORG = "0de00000-0000-0000-0000-0000000de000"; // = DEV_ORG
const USER = "u_dev"; // = DEV_USER
const A1 = "0de00000-0000-0000-0000-0000000000a1"; // lista
const A2 = "0de00000-0000-0000-0000-0000000000a2"; // generando
const A3 = "0de00000-0000-0000-0000-0000000000a3"; // congelada

const VISTA = JSON.stringify({
  version_vista: 1, titulo: "Reporte mensual de ventas", archivoSalida: "resultado.json",
  bloques: [
    { tipo: "resumen", texto: "@resultado.resumen" },
    { tipo: "metricas", items: [{ etiqueta: "Ventas del mes", valor: "@resultado.total", formato: "moneda" }] },
  ],
});

async function main() {
  const admin = crearPool(ADMIN_URL);
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
    // A1: versión LISTA (con vista) → estado 'lista'. + 2 ejecuciones.
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,vista) VALUES ($1,$2,1,'lista',$3::jsonb)", [A1, ORG, VISTA]);
    const v1 = (await admin.query<{ id: string }>("SELECT id FROM versiones WHERE automatizacion_id=$1 LIMIT 1", [A1])).rows[0]!.id;
    await admin.query("INSERT INTO ejecuciones (version_id,org_id,estado,ms,costo_usd) VALUES ($1,$2,'ok',1240,0),($1,$2,'ok',980,0)", [v1, ORG]);
    // A2: versión BUILDING → estado 'generando'.
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado) VALUES ($1,$2,1,'building')", [A2, ORG]);
    // A3: versión lista pero ciclo FROZEN → estado 'congelada'.
    await admin.query("INSERT INTO versiones (automatizacion_id,org_id,numero,estado,vista) VALUES ($1,$2,1,'lista',$3::jsonb)", [A3, ORG, VISTA]);
    await admin.query("UPDATE automatizaciones SET ciclo_estado='frozen' WHERE id=$1", [A3]);
    // Algo de consumo del mes para que el panel de cuenta muestre uso real.
    await admin.query("INSERT INTO uso_periodo (org_id,periodo,generaciones,ejecuciones) VALUES ($1, to_char(now(),'YYYY-MM'), 3, 2) ON CONFLICT (org_id,periodo) DO UPDATE SET generaciones=3, ejecuciones=2", [ORG]);

    console.log("✓ Sembrado el modo dev:");
    console.log(`  org      ${ORG}  (plan equipo)`);
    console.log(`  usuario  ${USER}  (admin) + Luis, Carmen (operadores)`);
    console.log("  3 automatizaciones: 'lista' (2 ejecuciones), 'generando', 'congelada'");
    console.log("\nEn web/.env.local pon:");
    console.log("  AUTOMATA_DEV_AUTH=1");
    console.log("  DATABASE_URL=postgres://automata_app@127.0.0.1:55432/postgres");
    console.log("  APP_ORIGIN=http://localhost:3000");
    console.log(`  NEXT_PUBLIC_AUTOMATA_DEV_ORG=${ORG}`);
  } finally {
    await admin.end();
  }
}
main().catch((e) => { console.error("Error sembrando:", e); process.exit(1); });
