// ─────────────────────────────────────────────────────────────────────────────
// LOTE DE MUTACIONES: encadena muchas corridas de `mutar.ts` en SERIE y resume el resultado.
//
// Por qué en serie y no en paralelo: `mutar.ts` ESCRIBE en el archivo de producción y lo restaura
// al terminar. Dos mutaciones a la vez sobre el mismo archivo se pisan, y los verify `:pg` comparten
// un único Postgres y colas GLOBALES (`build_pendiente`, `ajuste_pendiente`) — una fila de otro test
// desvía los conteos. Paralelizar esto no da una auditoría más rápida: da una auditoría FALSA, que
// es peor que ninguna.
//
//   npx tsx scripts/mutar-lote.ts <lote.json> [salida.json]
//
// El JSON de entrada es un arreglo de:
//   { archivo, buscar, reemplazar, verify, sql?, garantia?, gravedad?, siSobrevive? }
//
// Resultados:
//   MATA       → el verify falló con el código roto. El test sirve. ✅
//   SOBREVIVE  → siguió en verde. El test es ciego ahí. ❌ HALLAZGO
//   INCONCLUSO → la mutación no llegó a la BD (dentro de un CREATE TABLE). No cuenta.
//   SE CUELGA  → el verify no terminó a tiempo con la mutación.
//   ERROR      → el `buscar` no aparece, o aparece más de una vez. La propuesta se descarta;
//                NO es un hallazgo (confundirlos infla la auditoría con humo).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

interface Mutacion {
  archivo: string;
  buscar: string;
  reemplazar: string;
  verify: string;
  sql?: boolean;
  garantia?: string;
  gravedad?: string;
  siSobrevive?: string;
}

const [entrada, salida = "mutaciones-resultado.json"] = process.argv.slice(2);
if (!entrada) {
  console.error("uso: tsx scripts/mutar-lote.ts <lote.json> [salida.json]");
  process.exit(2);
}

const lote: Mutacion[] = JSON.parse(readFileSync(entrada, "utf8"));
console.log(`▶ ${lote.length} mutaciones, en serie. Esto tarda: cada una corre un verify completo.\n`);

type Estado = "MATA" | "SOBREVIVE" | "INCONCLUSO" | "SE CUELGA" | "ERROR";
const resultados: (Mutacion & { estado: Estado; detalle: string; segundos: number })[] = [];

/** Clasifica por lo que IMPRIME el arnés, no por el código de salida: `mutar.ts` sale 1 tanto en
 *  SOBREVIVE como en algunos abortos, y confundirlos inventaría hallazgos que no existen. */
function clasificar(texto: string, status: number | null): { estado: Estado; detalle: string } {
  const linea = texto.split("\n").find((l) => /MATA|SOBREVIVE|INCONCLUSO|SE CUELGA/.test(l)) ?? "";
  if (/SOBREVIVE/.test(texto)) return { estado: "SOBREVIVE", detalle: linea.trim() };
  if (/INCONCLUSO/.test(texto)) return { estado: "INCONCLUSO", detalle: linea.trim() };
  if (/SE CUELGA/.test(texto)) return { estado: "SE CUELGA", detalle: linea.trim() };
  if (/MATA/.test(texto)) return { estado: "MATA", detalle: linea.trim() };
  const err = texto.split("\n").filter(Boolean).slice(-2).join(" ").trim();
  return { estado: "ERROR", detalle: err.slice(0, 180) || `sin salida (status ${status})` };
}

for (const [i, m] of lote.entries()) {
  const args = [
    "tsx", "scripts/mutar.ts",
    ...(m.sql ? ["--sql"] : []),
    m.archivo, m.buscar, m.reemplazar, m.verify,
  ];
  const t0 = Date.now();
  const r = spawnSync("npx", args, { encoding: "utf8", stdio: "pipe" });
  const segundos = Math.round((Date.now() - t0) / 1000);
  const { estado, detalle } = clasificar(`${r.stdout ?? ""}\n${r.stderr ?? ""}`, r.status);

  const icono = { MATA: "✓", SOBREVIVE: "✗ HALLAZGO", INCONCLUSO: "·", "SE CUELGA": "⏱", ERROR: "!" }[estado];
  console.log(
    `[${String(i + 1).padStart(2)}/${lote.length}] ${icono} ${estado.padEnd(10)} ${m.verify.padEnd(28)} ` +
    `${m.archivo} :: ${m.buscar.slice(0, 46).replace(/\n/g, "⏎")}  (${segundos}s)`,
  );
  if (estado === "ERROR") console.log(`         ↳ ${detalle}`);

  resultados.push({ ...m, estado, detalle, segundos });
  // Se escribe en CADA vuelta: si esto se interrumpe a la mutación 60 de 80, lo hecho no se pierde.
  writeFileSync(salida, JSON.stringify(resultados, null, 2));
}

const cuenta = (e: Estado) => resultados.filter((r) => r.estado === e).length;
console.log(`\n${"─".repeat(80)}`);
console.log(
  `MATA ${cuenta("MATA")}  ·  SOBREVIVE ${cuenta("SOBREVIVE")}  ·  INCONCLUSO ${cuenta("INCONCLUSO")}` +
  `  ·  SE CUELGA ${cuenta("SE CUELGA")}  ·  ERROR ${cuenta("ERROR")}`,
);

const hallazgos = resultados.filter((r) => r.estado === "SOBREVIVE");
if (hallazgos.length) {
  console.log(`\nHALLAZGOS (el test siguió en verde con el código roto):`);
  const orden = { critica: 0, alta: 1, media: 2, baja: 3 } as Record<string, number>;
  for (const h of hallazgos.sort((a, b) => (orden[a.gravedad ?? "baja"] ?? 9) - (orden[b.gravedad ?? "baja"] ?? 9))) {
    console.log(`  [${(h.gravedad ?? "?").toUpperCase()}] ${h.verify} — ${h.garantia ?? h.buscar}`);
    if (h.siSobrevive) console.log(`      en producción: ${h.siSobrevive}`);
  }
}
console.log(`\nDetalle completo en ${salida}`);
