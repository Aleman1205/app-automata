// ─────────────────────────────────────────────────────────────────────────────
// Verificación del sandbox "puente" del Run (a5-Fase 0). Corre python REAL con fixtures
// hostiles y límites inyectados chicos (para que timeout/cotas se prueben en segundos):
//   1. FUGA DE SECRETOS: el código de IA NO ve DATABASE_URL/ANTHROPIC/… (env allowlist).
//   2. RESULTADO GIGANTE: un resultado.json enorme LANZA antes de JSON.parse (anti-OOM).
//   3. HAPPY PATH: un script normal sigue corriendo (el endurecimiento no rompió el Run).
//   4. TIMEOUT: un bucle infinito lo mata el reloj de pared (kill del grupo).
// La red y el aislamiento cross-tenant NO se prueban aquí: siguen abiertos por diseño en
// el puente (compuerta anti-promoción); los cierra el runner de Fase 1/2.
//   npm run verify:sandbox
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalPythonExecutor, LIMITES_DEFAULT } from "../src/run/executor.ts";
import type { Artefacto } from "../src/types.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const arte = (py: string): Artefacto => ({ automatizacionPy: py, manifiesto: { entradas: [] }, vista: { bloques: [] } as unknown as Artefacto["vista"] });
const PREAMBULO = "import sys,os,json\nout=sys.argv[sys.argv.index('--salida')+1]\n";
const escribir = (obj: string) => `${PREAMBULO}json.dump(${obj}, open(os.path.join(out,'resultado.json'),'w'))\n`;

async function main() {
  const dummy = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "automata-in-")), "in.txt");
  await fs.writeFile(dummy, "x");
  const inputs = { archivo: dummy };

  // Sembramos secretos en el env del PADRE para probar que el HIJO no los ve.
  const prev = { s: process.env.SECRET_PROBE, d: process.env.DATABASE_URL };
  process.env.SECRET_PROBE = "no-me-filtres";
  process.env.DATABASE_URL = "postgres://user:pass@host/db";

  try {
    console.log("1. Fuga de secretos (env allowlist):");
    const ex = new LocalPythonExecutor();
    const r1 = await ex.run(arte(escribir("{'env_keys': sorted(os.environ.keys())}")), inputs);
    const keys = (r1.resultado as { env_keys: string[] }).env_keys;
    check("el código de IA NO ve SECRET_PROBE", !keys.includes("SECRET_PROBE"));
    check("el código de IA NO ve DATABASE_URL", !keys.includes("DATABASE_URL"));
    check("tampoco variables típicas de secreto (ANTHROPIC/AWS/*_KEY/*_TOKEN)", !keys.some((k) => /ANTHROPIC|AWS|SECRET|TOKEN|KEY|PASSWORD/i.test(k)));
    check("sí hereda lo mínimo seguro (PATH, HOME)", keys.includes("PATH") && keys.includes("HOME"));

    console.log("\n2. Resultado gigante → cota anti-OOM (antes de JSON.parse):");
    const exChico = new LocalPythonExecutor({ resultMaxBytes: 1024 });
    const gigante = `${PREAMBULO}f=open(os.path.join(out,'resultado.json'),'w'); f.write('['+('0,'*20000)+'0]'); f.close()\n`;
    check("un resultado.json > cota LANZA (no se carga a RAM)", await exChico.run(arte(gigante), inputs).then(() => false).catch(() => true));

    console.log("\n3. Happy path (el endurecimiento no rompió el Run normal):");
    const r3 = await ex.run(arte(escribir("{'ok': True, 'n': 42}")), inputs);
    const res = r3.resultado as { ok: boolean; n: number };
    check("un script normal corre y devuelve su resultado", res.ok === true && res.n === 42);
    check("reporta salidas y costo local $0", r3.salidas.includes("resultado.json") && r3.costoUsd === 0);

    console.log("\n4. Timeout (bucle infinito → kill del grupo por reloj de pared):");
    const exTimeout = new LocalPythonExecutor({ timeoutMs: 2000 });
    const t0 = Date.now();
    const murio = await exTimeout.run(arte(`${PREAMBULO}\nwhile True: pass\n`), inputs).then(() => false).catch((e) => /excedió/.test(String(e)));
    check("un bucle infinito se mata por timeout (~2s)", murio && Date.now() - t0 < 15_000);

    // ── El agente es ESTOCÁSTICO y elige cómo leer sus argumentos ──
    // Un build cuesta ~$1.8 y no se puede pedir "otra vez pero con mi convención": el Run tiene que
    // aterrizar las dos. Ninguna de las dos estaba probada, y por eso pasaron desapercibidos dos
    // errores seguidos: primero el Run solo entendía --salida (el 1er build real escribió un archivo
    // llamado literalmente "--salida" y se perdió); luego el arreglo pasó AMBAS convenciones en la
    // misma invocación y rompió a los scripts con argparse, que son los que el prompt pide.
    console.log("\n5. Las DOS convenciones de invocación aterrizan (escalera, no todo junto):");
    const argparsePy = [
      "import argparse, json, os",
      "p = argparse.ArgumentParser()",
      "p.add_argument('entrada')",
      "p.add_argument('--salida', default='.')",
      "a = p.parse_args()",
      "json.dump({'via': 'argparse'}, open(os.path.join(a.salida, 'resultado.json'), 'w'))",
    ].join("\n");
    const r5a = await ex.run(arte(argparsePy), inputs);
    check("argparse estricto: un positional de más lo abortaría con 'unrecognized arguments'",
      (r5a.resultado as { via: string }).via === "argparse");

    // Lo que hizo el primer build real: argv[2] como RUTA del resultado. Con --salida escribe un
    // archivo llamado "--salida" y termina en 0, así que el fallo es silencioso: hay que reintentar.
    const posicionalPy = "import sys, json\njson.dump({'via': 'posicional'}, open(sys.argv[2], 'w'))\n";
    const r5b = await ex.run(arte(posicionalPy), inputs);
    check("argv[2] = ruta del resultado (lo que eligió el 1er build real, hoy se rescata)",
      (r5b.resultado as { via: string }).via === "posicional");
  } finally {
    process.env.SECRET_PROBE = prev.s; process.env.DATABASE_URL = prev.d;
    if (prev.s === undefined) delete process.env.SECRET_PROBE;
    if (prev.d === undefined) delete process.env.DATABASE_URL;
    await fs.rm(path.dirname(dummy), { recursive: true, force: true }).catch(() => {});
  }

    // ── El guard que impide correr código de IA SIN JAULA en producción ──────
    // LocalPythonExecutor no aísla red, FS ni kernel: es el puente de desarrollo. Lo único que
    // impide que corra en producción es `permitirEnProduccion: false` por defecto + el chequeo de
    // NODE_ENV. Una auditoría por mutación lo destapó: cambiando ese default a `true`, TODA la
    // suite seguía en verde — o sea que se podía habilitar la ejecución sin jaula de código
    // generado por IA, en producción y multi-tenant, sin que un solo test se quejara. Es el riesgo
    // #1 del threat model (docs/11: escape de contenedor).
    console.log("\n6. Guard anti-producción (correr sin jaula es el riesgo #1 del threat model):");
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      check("en producción, construirlo SIN la bandera explícita LANZA",
        (() => { try { new LocalPythonExecutor(); return false; } catch { return true; } })());
      check("la bandera explícita sigue siendo la ÚNICA salida (para dev/pruebas)",
        (() => { try { new LocalPythonExecutor({ permitirEnProduccion: true }); return true; } catch { return false; } })());
      check("el DEFAULT de permitirEnProduccion es false (si fuera true, el guard sería decorativo)",
        LIMITES_DEFAULT.permitirEnProduccion === false);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    }
    check("fuera de producción no estorba", (() => { try { new LocalPythonExecutor(); return true; } catch { return false; } })());

    // Los casos de arriba INYECTAN límites chicos para poder disparar el corte en segundos, así que
    // no ejercitan los valores por defecto — que son los que corren de verdad. Probarlos por
    // comportamiento costaría 5 minutos de reloj (el timeout real), así que se afirman como números.
    console.log("\n7. Los límites POR DEFECTO del Run (los que corren de verdad):");
    check(`timeoutMs sensato (${LIMITES_DEFAULT.timeoutMs / 1000}s)`, LIMITES_DEFAULT.timeoutMs > 0 && LIMITES_DEFAULT.timeoutMs <= 600_000);
    check(`outMaxFiles sensato (${LIMITES_DEFAULT.outMaxFiles})`, LIMITES_DEFAULT.outMaxFiles > 0 && LIMITES_DEFAULT.outMaxFiles <= 1000);
    check(`outMaxBytes sensato (${LIMITES_DEFAULT.outMaxBytes / 1024 / 1024} MB)`, LIMITES_DEFAULT.outMaxBytes > 0 && LIMITES_DEFAULT.outMaxBytes <= 512 * 1024 * 1024);
    check(`resultMaxBytes sensato (${LIMITES_DEFAULT.resultMaxBytes / 1024 / 1024} MB)`, LIMITES_DEFAULT.resultMaxBytes > 0 && LIMITES_DEFAULT.resultMaxBytes <= 64 * 1024 * 1024);
    check(`cpuMaxS sensato (${LIMITES_DEFAULT.cpuMaxS}s)`, LIMITES_DEFAULT.cpuMaxS > 0 && LIMITES_DEFAULT.cpuMaxS <= 600);
    check(`fsizeMaxKb sensato (${LIMITES_DEFAULT.fsizeMaxKb / 1024} MB)`, LIMITES_DEFAULT.fsizeMaxKb > 0 && LIMITES_DEFAULT.fsizeMaxKb <= 512 * 1024);

  console.log(`\n${ok ? "✓ SANDBOX PUENTE PROBADO" : "✗ FALLÓ"} — el código de IA no hereda secretos, el resultado está acotado, el Run normal sigue vivo y el timeout mata el grupo. (Red/aislamiento real = Fase 1/2.)`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
