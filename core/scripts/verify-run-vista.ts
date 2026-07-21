// ─────────────────────────────────────────────────────────────────────────────
// Verificación GRATIS de M0: prueba la mitad run -> resolver-vista SIN gastar y
// SIN modelo, reusando el artefacto que el agente YA construyó en el spike
// (spike/salidas/dashboard-popularidad/automatizacion.py).
//
// Prueba, de punta a punta y por $0:
//   1. El RUN corre el artefacto sobre el xlsx real (Python, sin modelo).
//   2. El resolver aterriza la vista.json (@resultado.*) sobre el resultado.
//   3. La salida es un Resultado válido (los mismos bloques que el front renderiza).
// Y responde el residual de (b): ¿el Run corre sin modelo? → sí, y su costo.
//
//   npm run verify        (desde core/)
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Artefacto, Bloque, Manifiesto, Vista } from "../src/types.ts";
import { LocalPythonExecutor, costoCmaEquivalente } from "../src/run/executor.ts";
import { resolverVista, VistaError } from "../src/vista/resolver.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", ".."); // raíz del repo
const ARTIF = path.join(RAIZ, "spike", "salidas", "dashboard-popularidad");
const XLSX = path.join(RAIZ, "spike", "datos", "gastos.xlsx");

function fmt(n: number): string {
  return n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  // ── Cargar el artefacto ya construido como si viniera del Storage ──
  for (const [etiqueta, p] of [["artefacto", path.join(ARTIF, "automatizacion.py")], ["insumo", XLSX]] as const) {
    try {
      await fs.access(p);
    } catch {
      console.error(`✗ Falta el ${etiqueta}: ${p}`);
      console.error("  Genera el insumo con:  npm run datos:vitrales   (en la raíz)");
      console.error("  o corre el spike para tener el artefacto en spike/salidas/.");
      process.exit(1);
    }
  }

  const automatizacionPy = await fs.readFile(path.join(ARTIF, "automatizacion.py"), "utf8");
  const vista = JSON.parse(
    await fs.readFile(path.join(AQUI, "..", "src", "cases", "dashboard-popularidad.vista.json"), "utf8"),
  ) as Vista;
  const manifiesto: Manifiesto = { entradas: [{ nombre: "reporte", tipo: "archivo", formato: "xlsx", descripcion: "", requerido: true }] };
  const artefacto: Artefacto = { automatizacionPy, manifiesto, vista };

  // ── 1. RUN (Python, sin modelo) ──
  console.log("1. Ejecutando el artefacto sobre el xlsx real (RUN, sin modelo)…");
  const executor = new LocalPythonExecutor();
  const { resultado: datos, ms, costoUsd, salidas } = await executor.run(artefacto, { reporte: XLSX });
  console.log(`   ✓ corrió en ${(ms / 1000).toFixed(1)}s · costo local $${costoUsd} · equivalente CMA $${costoCmaEquivalente(ms).toFixed(5)} (solo session-hours, SIN modelo)`);
  console.log(`   salidas: ${salidas.join(", ")}`);

  // ── 2. Resolver la vista (la puerta de calidad de docs/09) ──
  console.log("\n2. Aterrizando la vista.json (@resultado.*) sobre el resultado…");
  let resultado;
  try {
    resultado = resolverVista(vista, datos);
  } catch (e) {
    if (e instanceof VistaError) {
      console.error(`   ✗ La puerta de calidad rechazó la vista: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  console.log(`   ✓ vista resuelta: ${resultado.bloques.length} bloques`);

  // ── 3. Verificar que la salida es un Resultado válido ──
  console.log("\n3. Verificando la forma del Resultado (lo que el front renderiza)…");
  const tipos = resultado.bloques.map((b) => b.tipo);
  const chequeos: [string, boolean][] = [
    ["tiene archivoSalida", typeof resultado.archivoSalida === "string" && resultado.archivoSalida.length > 0],
    ["tiene bloque resumen", tipos.includes("resumen")],
    ["tiene bloque metricas", tipos.includes("metricas")],
    ["tiene gráfica (barras/ranking)", tipos.includes("barras") || tipos.includes("ranking")],
    ["tiene tabla", tipos.includes("tabla")],
    ["todo bloque tiene tipo válido", resultado.bloques.every((b: Bloque) => typeof b.tipo === "string")],
  ];
  let ok = true;
  for (const [nombre, paso] of chequeos) {
    console.log(`   ${paso ? "✓" : "✗"} ${nombre}`);
    ok = ok && paso;
  }

  // Muestra las cifras reales que quedaron enlazadas (que no sea todo cero).
  const met = resultado.bloques.find((b) => b.tipo === "metricas");
  if (met && met.tipo === "metricas") {
    console.log("\n   Métricas enlazadas desde el resultado real:");
    for (const m of met.items) console.log(`     · ${m.etiqueta}: ${fmt(m.valor)}${m.sufijo ?? ""}`);
  }
  const ranking = resultado.bloques.find((b) => b.tipo === "ranking");
  if (ranking && ranking.tipo === "ranking") {
    console.log(`   Top-1 (${ranking.titulo}): ${ranking.datos[0]?.etiqueta} — ${fmt(ranking.datos[0]?.valor ?? 0)}`);
  }

  console.log(`\n${ok ? "✓ M0 (mitad run→vista) PROBADA" : "✗ FALLÓ"} — el loop artefacto→run→vista funciona, por $0 y sin modelo.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
