// ─────────────────────────────────────────────────────────────────────────────
// M0 completo: el loop build -> artefacto -> run -> vista, tejido con el pipeline
// y los puertos (Storage local, State en memoria, Run local).
//
//   npm run m0            reusa el artefacto ya construido del spike (gratis)
//   npm run m0 -- --build construye de verdad en CMA (~$2, ~10 min, necesita
//                         ANTHROPIC_API_KEY y acceso a Managed Agents)
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildClient, CodigoConstruido, Manifiesto, Spec, Vista } from "../src/types.ts";
import { CmaBuildClient } from "../src/cma/build.ts";
import { LocalPythonExecutor, costoCmaEquivalente } from "../src/run/executor.ts";
import { LocalStorage } from "../src/storage/local.ts";
import { MemoryStateRepo } from "../src/state/memory.ts";
import { construir, ejecutar, type Deps } from "../src/pipeline/build-pipeline.ts";
import { dashboardPopularidadSpec } from "../src/cases/dashboard-popularidad.spec.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");
const ARTIF = path.join(RAIZ, "spike", "salidas", "dashboard-popularidad");
const XLSX = path.join(RAIZ, "spike", "datos", "gastos.xlsx");

// BuildClient que reutiliza el artefacto ya construido del spike (gratis).
class ReuseArtifactBuildClient implements BuildClient {
  async build(_spec: Spec, _ejemplo: string) {
    const automatizacionPy = await fs.readFile(path.join(ARTIF, "automatizacion.py"), "utf8");
    let manifiesto: Manifiesto = { entradas: [] };
    try {
      manifiesto = JSON.parse(await fs.readFile(path.join(ARTIF, "manifiesto.json"), "utf8")) as Manifiesto;
    } catch {
      /* sin manifiesto: se deja vacío */
    }
    const codigo: CodigoConstruido = { automatizacionPy, manifiesto };
    return { codigo, costoUsd: 0, iteraciones: 1, aprobado: true };
  }
}

async function main() {
  const conBuild = process.argv.includes("--build");
  let contador = 0;
  const deps: Deps = {
    storage: new LocalStorage(path.join(AQUI, "..", ".artefactos")),
    state: new MemoryStateRepo(),
    build: conBuild ? new CmaBuildClient() : new ReuseArtifactBuildClient(),
    run: new LocalPythonExecutor(),
    // Reloj determinista (el core no usa Date directo); en producción es new Date().
    ahora: () => `t${(contador += 1)}`,
  };

  if (conBuild) {
    console.log("⚠️  --build: se construirá en CMA de verdad (~$2, ~10 min).");
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("   Falta ANTHROPIC_API_KEY. Exporta la key o corre sin --build.");
      process.exit(1);
    }
  } else {
    console.log("Modo reuse: se reutiliza el artefacto del spike (gratis). Usa --build para CMA real.");
  }

  const vista = JSON.parse(
    await fs.readFile(path.join(AQUI, "..", "src", "cases", "dashboard-popularidad.vista.json"), "utf8"),
  ) as Vista;

  // ── build -> artefacto ──
  console.log("\n[1/2] Construyendo (o reusando) el artefacto…");
  const { version, artefacto, costoUsd, iteraciones } = await construir(deps, {
    orgId: "org_demo",
    nombre: "Dashboard de popularidad de productos",
    spec: dashboardPopularidadSpec,
    vista,
    ejemploPath: XLSX,
  });
  console.log(`   ✓ versión ${version.id} ${version.estado} · $${costoUsd.toFixed(2)} · ${iteraciones} iteración(es)`);

  // ── run -> vista ──
  console.log("\n[2/2] Ejecutando el artefacto y aterrizando la vista…");
  const { resultado, ejecucion, ms } = await ejecutar(deps, {
    version,
    artefacto,
    inputs: { reporte: XLSX },
  });
  console.log(`   ✓ ejecución ${ejecucion.id} · ${(ms / 1000).toFixed(1)}s · costo Run local $${ejecucion.costoUsd} (CMA ~$${costoCmaEquivalente(ms).toFixed(5)})`);
  console.log(`   ✓ ${resultado.bloques.length} bloques resueltos, listos para el front.`);

  console.log("\n✓ M0: loop build→artefacto→run→vista completo.");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
