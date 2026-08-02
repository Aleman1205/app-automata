// ─────────────────────────────────────────────────────────────────────────────
// Verificación del RUNNER DE CONTENEDOR (ContainerRunExecutor) — la jaula que en producción
// ejecuta el código generado por IA.
//
// Por qué existe: esas 133 líneas NUNCA se habían ejercido. El otro executor
// (LocalPythonExecutor) también estaba "cableado con cuidado" y falló DOS veces seguidas en
// cuanto tocó la realidad —el archivo llamado literalmente "--salida", y luego el parche que
// rompió a los scripts con argparse—, a ~$1.8 el build. Estrenar este el día del despliegue,
// sobre el camino que ejecuta código ajeno, es la peor forma de descubrir lo mismo.
//
// Corre con el runtime NORMAL de Docker (runc), no con gVisor: runsc es solo Linux y aquí no
// existe. O sea que esto NO prueba el aislamiento de gVisor — prueba todo lo demás: montajes,
// permisos, paso de argumentos, recolección de la salida, sin-red, rootfs de solo lectura,
// timeout y que no queden contenedores huérfanos. Al desplegar en Linux, la ÚNICA variable
// nueva sería `--runtime=runsc`.
//
//   docker debe estar corriendo.  npm run verify:contenedor
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContainerRunExecutor } from "../src/run/container-executor.ts";
import type { Artefacto } from "../src/types.ts";

// Imagen mínima con python. No lleva pandas/openpyxl: aquí se prueba el RUNNER, no las deps.
const IMAGEN = process.env.IMAGEN_PRUEBA ?? "python:3.11-slim";
// El runtime se elige por env para poder correr ESTE MISMO test bajo gVisor en un host Linux
// (RUNTIME_PRUEBA=runsc) sin tocar una línea. En la Mac no existe runsc, así que el default es el
// runtime normal: lo que se prueba aquí son montajes, permisos, argumentos, sin-red, solo-lectura,
// timeout y cotas — todo menos la jaula. Con `runsc` los MISMOS 7 checks ejercen la jaula real.
const RUNTIME = process.env.RUNTIME_PRUEBA ?? "runc";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };
const arte = (py: string): Artefacto => ({
  automatizacionPy: py,
  manifiesto: { entradas: [] },
  vista: { bloques: [] } as unknown as Artefacto["vista"],
});
// runtime: el normal en la Mac, "runsc" (gVisor) donde exista.
const ex = (o: Record<string, unknown> = {}) =>
  new ContainerRunExecutor({ imagen: IMAGEN, runtime: RUNTIME, timeoutMs: 60_000, ...o });

const docker = (...a: string[]) => spawnSync("docker", a, { encoding: "utf8", timeout: 120_000 });

async function main() {
  console.log(`· runtime: ${RUNTIME}${RUNTIME === "runsc" ? "  (gVisor: la jaula REAL)" : "  (sin jaula: gVisor solo existe en Linux)"}\n`);
  if (docker("info").status !== 0) {
    console.error("✗ Docker no responde. Arranca Docker Desktop y vuelve a correrlo.");
    process.exit(2);
  }
  if (docker("image", "inspect", IMAGEN).status !== 0) {
    console.log(`· Bajando ${IMAGEN} (una vez)…`);
    if (docker("pull", IMAGEN).status !== 0) { console.error(`✗ No se pudo bajar ${IMAGEN}`); process.exit(2); }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cont-in-"));
  const entrada = path.join(dir, "datos.csv");
  await fs.writeFile(entrada, "vendedor,monto\nAna,100\n");
  const inputs = { archivo: entrada };
  const contenedoresAntes = () => (docker("ps", "-q").stdout ?? "").trim().split("\n").filter(Boolean).length;

  try {
    console.log("1. Happy path — ¿el resultado sale del contenedor?");
    // El contrato del prompt: <entrada> --salida <dir>. Es lo único que este executor pasa hoy.
    const okPy = [
      "import sys, json, os",
      "out = sys.argv[sys.argv.index('--salida') + 1]",
      "json.dump({'ok': True, 'filas': 1}, open(os.path.join(out, 'resultado.json'), 'w'))",
    ].join("\n");
    const r1 = await ex().run(arte(okPy), inputs).catch((e) => e as Error);
    check("corre y devuelve el resultado parseado",
      !(r1 instanceof Error) && (r1.resultado as { ok: boolean }).ok === true);
    if (r1 instanceof Error) console.log(`     (error: ${r1.message.slice(0, 200)})`);

    console.log("\n2. El contenedor corre como nobody: ¿PUEDE escribir en /out?");
    // El montaje /out lo crea el usuario del host; dentro se corre con --user 65534 (nobody).
    // Si los permisos no lo permiten, el script no puede escribir su resultado y el error sale
    // como "no produjo un resultado JSON" — apuntando al agente en vez de al montaje.
    check("nobody escribe en /out (si falla, es el MONTAJE, no el script)", !(r1 instanceof Error));

    console.log("\n3. Aislamiento de red (--network none):");
    const redPy = [
      "import socket, sys, json, os",
      "out = sys.argv[sys.argv.index('--salida') + 1]",
      "try:",
      "    socket.create_connection(('1.1.1.1', 53), timeout=3); alcanzo = True",
      "except Exception:",
      "    alcanzo = False",
      "json.dump({'alcanzo': alcanzo}, open(os.path.join(out, 'resultado.json'), 'w'))",
    ].join("\n");
    const r3 = await ex().run(arte(redPy), inputs).catch((e) => e as Error);
    check("el código de IA NO alcanza la red",
      !(r3 instanceof Error) && (r3.resultado as { alcanzo: boolean }).alcanzo === false);

    console.log("\n4. Rootfs de solo lectura (--read-only):");
    const escribePy = [
      "import sys, json, os",
      "out = sys.argv[sys.argv.index('--salida') + 1]",
      "try:",
      "    open('/escribeme.txt', 'w').write('x'); pudo = True",
      "except Exception:",
      "    pudo = False",
      "json.dump({'pudo': pudo}, open(os.path.join(out, 'resultado.json'), 'w'))",
    ].join("\n");
    const r4 = await ex().run(arte(escribePy), inputs).catch((e) => e as Error);
    check("no puede escribir fuera de /out",
      !(r4 instanceof Error) && (r4.resultado as { pudo: boolean }).pudo === false);

    console.log("\n5. Timeout — ¿mata el contenedor o deja un huérfano corriendo?");
    const antes = contenedoresAntes();
    const t0 = Date.now();
    const r5 = await ex({ timeoutMs: 5000 }).run(arte("while True: pass\n"), inputs).catch((e) => e as Error);
    check("un bucle infinito se corta por timeout", r5 instanceof Error && /exced/i.test(r5.message) && Date.now() - t0 < 30_000);
    // Matar el cliente `docker` NO mata necesariamente el contenedor: seguiría quemando CPU y RAM
    // del host después del timeout. Es un leak silencioso, y en un runner multi-tenant se acumula.
    await new Promise((r) => setTimeout(r, 3000));
    check(`no quedaron contenedores huérfanos (antes ${antes}, ahora ${contenedoresAntes()})`, contenedoresAntes() <= antes);

    console.log("\n6. Convención de invocación — la que ya costó un build de ~$1.8:");
    // El agente es estocástico. El executor LOCAL aprendió a intentar las dos formas; este solo
    // pasa `--salida`. Un script que lee argv[2] como ruta del resultado escribiría en un archivo
    // llamado literalmente "--salida" y el build se perdería, igual que la primera vez.
    const posicionalPy = "import sys, json\njson.dump({'via': 'posicional'}, open(sys.argv[2], 'w'))\n";
    const r6 = await ex().run(arte(posicionalPy), inputs).catch((e) => e as Error);
    check("argv[2] como ruta del resultado también aterriza",
      !(r6 instanceof Error) && (r6.resultado as { via: string }).via === "posicional");

    console.log("\n7. Cotas de salida (anti bomba de disco por el mount de escritura):");
    const bombaPy = [
      "import sys, os",
      "out = sys.argv[sys.argv.index('--salida') + 1]",
      "[open(os.path.join(out, f'f{i}.txt'), 'w').write('x') for i in range(500)]",
      "open(os.path.join(out, 'resultado.json'), 'w').write('{}')",
    ].join("\n");
    const r7 = await ex().run(arte(bombaPy), inputs).catch((e) => e as Error);
    check("500 archivos de salida se rechazan (el mount escribe en el disco del HOST)", r7 instanceof Error);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${ok ? "✓ RUNNER DE CONTENEDOR PROBADO" : "✗ FALLÓ"} — montajes, permisos, sin-red, solo-lectura, timeout y cotas. (gVisor NO: runsc es solo Linux; al desplegar, esa es la única variable nueva.)`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("Error:", e); process.exit(1); });
