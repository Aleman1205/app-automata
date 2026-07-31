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

// --sql: tras mutar, REAPLICA el esquema (y lo restaura al terminar). Sin esto, mutar schema.sql
// no tiene ningún efecto —la BD sigue con las funciones viejas— y todo saldría "MATA" por error,
// que es la peor forma de fallar: te dice que el test vigila algo que ni siquiera se rompió.
// Casi todo el cobro real (cobrar_build, los triggers de cuota, el circuit breaker) vive en SQL,
// así que sin este modo la auditoría del camino del dinero sería de mentira.
// OJO: solo es fiable en objetos que se recrean, o sea CREATE OR REPLACE FUNCTION. Un CREATE TABLE
// IF NOT EXISTS mutado NO altera la tabla existente: esa mutación no llega a la BD.
const args = process.argv.slice(2);
const sql = args.includes("--sql");
const [archivo, buscar, reemplazar, verify] = args.filter((a) => a !== "--sql");
if (!archivo || buscar === undefined || reemplazar === undefined || !verify) {
  console.error("uso: tsx scripts/mutar.ts [--sql] <archivo> <buscar> <reemplazar> <script-verify>");
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

/** Aplica el esquema tal como está EN DISCO. Devuelve null si aplicó, o el error si no. */
function aplicarEsquema(): string | null {
  const r = spawnSync("./scripts/bd-prueba.sh", [], { encoding: "utf8", stdio: "pipe" });
  return (r.status ?? 1) === 0 ? null : `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().slice(-600);
}

/**
 * ¿El texto a mutar vive DENTRO de un `CREATE TABLE`? Entonces la mutación NUNCA llega a la BD:
 * el esquema usa `CREATE TABLE IF NOT EXISTS` y sobre una tabla que ya existe no hace nada. El
 * verify corre contra la BD intacta, pasa, y el arnés reportaría "SOBREVIVE" — un hallazgo
 * FANTASMA. Pasó de verdad auditando el tope de ajustes: `CHECK (ajustes_usados <= 3)` mutado a
 * `<= 99` daba SOBREVIVE mientras la BD seguía con el 3.
 * Se detecta comparando la última sentencia abierta antes del match: si el `CREATE TABLE` está
 * DESPUÉS del último `;`, estamos dentro de él.
 */
function dentroDeCreateTable(texto: string, posicion: number): boolean {
  // Los comentarios se quitan ANTES de buscar el `;`: este esquema está lleno de prosa y uno de
  // esos comentarios ("…3 ajustes (cambios) incluidos;") tiene punto y coma, que hacía creer al
  // detector que la sentencia ya había cerrado. Se compara el orden dentro del texto limpio, así
  // que las posiciones desplazadas no importan.
  const antes = texto.slice(0, posicion).replace(/--[^\n]*/g, "");
  return antes.toUpperCase().lastIndexOf("CREATE TABLE") > antes.lastIndexOf(";");
}

if (sql && dentroDeCreateTable(original, original.indexOf(buscar))) {
  console.log("INCONCLUSO — el texto está dentro de un CREATE TABLE, y el esquema usa");
  console.log("   CREATE TABLE IF NOT EXISTS: sobre una tabla que ya existe, la mutación NO llega a");
  console.log("   la BD. El resultado sería un 'SOBREVIVE' falso. Para probar un constraint, mútalo");
  console.log("   con un ALTER TABLE … DROP/ADD CONSTRAINT, o recrea la BD desde cero.");
  process.exit(2);
}

const restaurar = () => {
  if (readFileSync(ruta, "utf8") !== original) writeFileSync(ruta, original);
  // Restaurar el ARCHIVO no basta: la BD se quedó con la función mutada y envenenaría todo lo que
  // corra después. Se reaplica el esquema bueno.
  if (sql) aplicarEsquema();
};
// Un Ctrl-C a media corrida dejaría el código mutado en el árbol.
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { restaurar(); process.exit(130); });

let salida = 1;
try {
  writeFileSync(ruta, original.replace(buscar, reemplazar));
  if (sql) {
    const err = aplicarEsquema();
    if (err) {
      // El esquema mutado ni siquiera aplica: no se probó nada. Decirlo, en vez de contarlo como
      // "MATA" (el verify habría fallado por la BD rota, no porque el test vigile algo).
      console.log(`INCONCLUSO — el esquema mutado no aplica, así que la mutación nunca llegó a la BD.`);
      console.log(`   ${err.split("\n").slice(-3).join(" | ")}`);
      process.exit(2);
    }
  }
  // TIMEOUT: una mutación puede COLGAR el verify en vez de romperlo (p.ej. si rompe un lock y el
  // test se queda esperando a otra transacción). Sin tope, el arnés se queda ahí para siempre y se
  // pierde la corrida — pasó auditando el downgrade de plan. Colgarse NO es "MATA": es su propia
  // categoría, y en CI es peor que fallar, porque bloquea en vez de reportar.
  const r = spawnSync("npm", ["run", verify], { encoding: "utf8", stdio: "pipe", timeout: 180_000 });
  if (r.error && (r.error as { code?: string }).code === "ETIMEDOUT") {
    console.log(`SE CUELGA — ${verify} no terminó en 180s con la mutación (no falla: se queda esperando).`);
    console.log(`   ${archivo}: ${JSON.stringify(buscar)} → ${JSON.stringify(reemplazar)}`);
    console.log("   Detecta el cambio, pero colgarse en CI bloquea el pipeline en vez de reportar.");
    restaurar();
    process.exit(0); // cuenta como detectado, pero queda anotado como cuelgue
  }
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
