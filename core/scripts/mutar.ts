// ─────────────────────────────────────────────────────────────────────────────
// ARNÉS DE MUTACIÓN: ¿el test que dice probar X, FALLA cuando rompes X?
//
// Un test que pasa siempre no prueba nada, y en este proyecto ya pasó varias veces: cuatro bugs
// críticos vivieron bajo 35 verify en verde; verify:notificaciones tenía los tipos de correo
// hardcodeados y 'invitacion' se coló sin una sola prueba; el primer verify:pasarela pasó CON el
// bug del price duplicado presente. Verde no es lo mismo que probado.
//
// Uso:
//   npx tsx scripts/mutar.ts <archivo> <buscar> <reemplazar> <script-verify>
//
// Ejemplo (¿de verdad se comprueba que una reparación no cobra?):
//   npx tsx scripts/mutar.ts src/pipeline/ajuste.ts '"falla"' '"pasa"' verify:ajuste:pg
//
// Interpretación:
//   MATA      → el verify falló con la mutación. El test SÍ vigila eso. ✅
//   SOBREVIVE → el verify siguió en verde con el código roto. El test es ciego ahí. ❌ hallazgo
//
// El archivo SIEMPRE se restaura (finally + señales), y al final se AFIRMA que quedó idéntico:
// dejar una mutación olvidada en el árbol es el único daño que esto podría hacer.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [archivo, buscar, reemplazar, verify] = process.argv.slice(2);
if (!archivo || buscar === undefined || reemplazar === undefined || !verify) {
  console.error("uso: tsx scripts/mutar.ts <archivo> <buscar> <reemplazar> <script-verify>");
  process.exit(2);
}

const ruta = path.resolve(process.cwd(), archivo);
const original = readFileSync(ruta, "utf8");

const apariciones = original.split(buscar).length - 1;
if (apariciones === 0) {
  console.error(`✗ El texto a mutar no aparece en ${archivo}: ${JSON.stringify(buscar)}`);
  process.exit(2);
}
// Mutar varias apariciones a la vez confunde el resultado: no sabrías CUÁL de ellas vigila el test.
if (apariciones > 1) {
  console.error(`✗ ${JSON.stringify(buscar)} aparece ${apariciones} veces en ${archivo}. Usa un fragmento único.`);
  process.exit(2);
}

const restaurar = () => {
  if (readFileSync(ruta, "utf8") !== original) writeFileSync(ruta, original);
};
// Un Ctrl-C a media corrida dejaría el código mutado en el árbol.
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { restaurar(); process.exit(130); });

let salida = 1;
try {
  writeFileSync(ruta, original.replace(buscar, reemplazar));
  const r = spawnSync("npm", ["run", verify], { encoding: "utf8", stdio: "pipe" });
  salida = r.status ?? 1;
  const fallos = (r.stdout ?? "").split("\n").filter((l) => l.includes("✗")).slice(0, 4);
  if (salida !== 0) {
    console.log(`MATA — ${verify} falló con la mutación (el test SÍ vigila esto)`);
    for (const f of fallos) console.log(`   ${f.trim()}`);
  } else {
    console.log(`SOBREVIVE — ${verify} siguió en VERDE con el código roto. El test es ciego aquí.`);
    console.log(`   ${archivo}: ${JSON.stringify(buscar)} → ${JSON.stringify(reemplazar)}`);
  }
} finally {
  restaurar();
}

// Cinturón y tirantes: que el archivo quedó EXACTAMENTE como estaba.
if (readFileSync(ruta, "utf8") !== original) {
  console.error(`✗✗ NO SE PUDO RESTAURAR ${archivo} — revísalo con git diff ANTES de seguir.`);
  process.exit(3);
}
process.exit(salida === 0 ? 1 : 0); // exit 0 = la mutación murió = el test hace su trabajo
