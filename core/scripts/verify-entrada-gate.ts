// ─────────────────────────────────────────────────────────────────────────────
// Verificación del CABLEADO del gate de entrada (a4). El gate ya estaba probado a nivel
// unidad (verify:entrada); esto prueba que AHORA se INVOCA: construir() y ejecutar() gatean
// y CORTAN antes de cualquier efecto secundario (crear la automatización / reservar la
// ejecución). Sin Postgres: se inyectan espías de StateRepo.
//   npm run verify:entrada:gate
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatearEjemplo, gatearInputs, gatearArchivoBytes, EntradaRechazada } from "../src/entrada/puente.ts";
import { construir, ejecutar, type Deps } from "../src/pipeline/build-pipeline.ts";
import type { StateRepo, Storage, BuildClient, RunExecutor, Spec, Vista, Version } from "../src/types.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const lanzaRechazo = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch (e) { return e instanceof EntradaRechazada; } };

const spec: Spec = { objetivo: "demo", reglas: [], criterios_exito: [], entradas: [] };
const vista: Vista = { version_vista: 1, titulo: "demo", archivoSalida: "out.json", bloques: [] };
const noLlamar = (nombre: string) => () => { throw new Error(`NO debió llamarse: ${nombre}`); };

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-"));
  const CSV = path.join(dir, "bueno.csv"); await fs.writeFile(CSV, "producto,ingreso\nTaco,100\nAgua,20\n");
  const VACIO = path.join(dir, "vacio.csv"); await fs.writeFile(VACIO, "");
  const ELF = path.join(dir, "malo.csv"); await fs.writeFile(ELF, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(64)]));
  const EXE = path.join(dir, "app.exe"); await fs.writeFile(EXE, "cualquier cosa");

  try {
    console.log("1. Puente directo (gatearEjemplo/gatearInputs):");
    check("un CSV legítimo pasa (no lanza)", await gatearEjemplo(CSV).then(() => true).catch(() => false));
    check("un ejecutable disfrazado de .csv → EntradaRechazada (spoofing)", await lanzaRechazo(() => gatearEjemplo(ELF)));
    check("un archivo vacío → EntradaRechazada (vacio)", await lanzaRechazo(() => gatearEjemplo(VACIO)));
    check("una extensión no permitida (.exe) → EntradaRechazada", await lanzaRechazo(() => gatearEjemplo(EXE)));
    check("gatearInputs con un input hostil → EntradaRechazada", await lanzaRechazo(() => gatearInputs({ a: ELF })));
    check("gatearInputs con inputs legítimos pasa", await gatearInputs({ a: CSV }).then(() => true).catch(() => false));

    console.log("\n1b. gatearArchivoBytes (variante en memoria, para el upload):");
    const lanzaBytes = (fn: () => void) => { try { fn(); return false; } catch (e) { return e instanceof EntradaRechazada; } };
    check("bytes de CSV legítimos → pasan", (() => { try { gatearArchivoBytes("bueno.csv", "csv", Buffer.from("producto,ingreso\nTaco,100\n")); return true; } catch { return false; } })());
    const elfBytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(64)]);
    check("bytes de ejecutable disfrazado de .csv → EntradaRechazada", lanzaBytes(() => gatearArchivoBytes("malo.csv", "csv", elfBytes)));
    check("bytes vacíos → EntradaRechazada", lanzaBytes(() => gatearArchivoBytes("vacio.csv", "csv", Buffer.alloc(0))));
    check("extensión no permitida (.exe) → EntradaRechazada", lanzaBytes(() => gatearArchivoBytes("app.exe", "exe", Buffer.from("x"))));

    console.log("\n2. construir() CORTA antes de crear la automatización:");
    let creoAuto = false;
    const stateBuild = {
      crearAutomatizacion: async () => { creoAuto = true; return { id: "x", orgId: "o", nombre: "n", activa: true }; },
    } as unknown as StateRepo;
    const depsBuild: Deps = {
      state: stateBuild,
      storage: {} as Storage,
      build: { build: noLlamar("build.build") } as unknown as BuildClient,
      run: {} as RunExecutor,
      ahora: () => "t",
    };
    check("construir con ejemplo hostil → EntradaRechazada", await lanzaRechazo(() => construir(depsBuild, { orgId: "o", nombre: "mala", spec, vista, ejemploPath: ELF })));
    check("...y NO creó la automatización (gate antes del efecto)", creoAuto === false);

    console.log("\n3. ejecutar() CORTA antes de reservar la ejecución:");
    let creoEjec = false;
    const stateRun = {
      crearEjecucion: async () => { creoEjec = true; return { id: "e", versionId: "v", estado: "reservada", ms: 0, costoUsd: 0, creada: "t" }; },
    } as unknown as StateRepo;
    const depsRun: Deps = {
      state: stateRun,
      storage: { getText: noLlamar("storage.getText") } as unknown as Storage,
      build: {} as BuildClient,
      run: { run: noLlamar("run.run") } as unknown as RunExecutor,
      ahora: () => "t",
    };
    const version = { id: "v", automatizacionId: "a", numero: 1, estado: "ready", artefactoKey: "artefactos/v.json", creada: "t" } as Version;
    check("ejecutar con input hostil → EntradaRechazada", await lanzaRechazo(() => ejecutar(depsRun, { version, inputs: { a: ELF } })));
    check("...y NO reservó la ejecución (gate antes del efecto)", creoEjec === false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${ok ? "✓ GATE CABLEADO PROBADO" : "✗ FALLÓ"} — construir/ejecutar invocan el gate y cortan ANTES de tocar la BD; el código de IA nunca ve un insumo hostil.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
