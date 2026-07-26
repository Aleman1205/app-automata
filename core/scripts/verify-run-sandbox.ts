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
import { LocalPythonExecutor } from "../src/run/executor.ts";
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
  } finally {
    process.env.SECRET_PROBE = prev.s; process.env.DATABASE_URL = prev.d;
    if (prev.s === undefined) delete process.env.SECRET_PROBE;
    if (prev.d === undefined) delete process.env.DATABASE_URL;
    await fs.rm(path.dirname(dummy), { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${ok ? "✓ SANDBOX PUENTE PROBADO" : "✗ FALLÓ"} — el código de IA no hereda secretos, el resultado está acotado, el Run normal sigue vivo y el timeout mata el grupo. (Red/aislamiento real = Fase 1/2.)`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
