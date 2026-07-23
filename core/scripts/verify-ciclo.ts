// ─────────────────────────────────────────────────────────────────────────────
// Verificación GRATIS de la máquina de estados del ciclo de vida (docs/08). Sin DB:
// clasificación cambio/reparación, guardas, transiciones, congelado. El enforcement
// atómico se prueba aparte contra Postgres (verify-ciclo-pg.ts).
//   npm run verify:ciclo
// ─────────────────────────────────────────────────────────────────────────────
import { clasificar, puedeAjustar, trasAjuste, congelar, ajustesRestantes, MAX_AJUSTES, type Ciclo } from "../src/ciclo/estados.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

console.log("1. Clasificación determinista cambio/reparación (docs/08 §2):");
check("ejemplo original PASA → cambio (consume ajuste)", clasificar("pasa") === "cambio");
check("ejemplo original FALLA → reparación (gratis)", clasificar("falla") === "reparacion");
check("INDETERMINADO (ausente/no ejecutable) → cambio (fail-safe: cobra, no se regala)", clasificar("indeterminado") === "cambio");

console.log("\n2. Ajustes restantes (● ● ○):");
check("nuevo (0 usados) → 3 restantes", ajustesRestantes({ estado: "ready", ajustesUsados: 0 }) === 3);
check("1 usado → 2 restantes", ajustesRestantes({ estado: "ready", ajustesUsados: 1 }) === 2);
check("3 usados → 0 restantes", ajustesRestantes({ estado: "frozen", ajustesUsados: 3 }) === 0);

console.log("\n3. Guardas de puedeAjustar:");
const ready0: Ciclo = { estado: "ready", ajustesUsados: 0 };
const frozen3: Ciclo = { estado: "frozen", ajustesUsados: 3 };
check("cambio sobre ready con ajustes → permitido", puedeAjustar(ready0, "cambio").permitido === true);
check("cambio sobre frozen → NO permitido (frozen)", puedeAjustar(frozen3, "cambio") .permitido === false);
check("  motivo = frozen", (puedeAjustar(frozen3, "cambio") as { motivo?: string }).motivo === "frozen");
check("cambio sobre ready pero ajustes agotados → NO (ajustes_agotados)", (puedeAjustar({ estado: "ready", ajustesUsados: 3 }, "cambio") as { motivo?: string }).motivo === "ajustes_agotados");
check("REPARACIÓN siempre permitida — incluso sobre frozen (obligación, no favor)", puedeAjustar(frozen3, "reparacion").permitido === true);
check("reparación sobre ready → permitida", puedeAjustar(ready0, "reparacion").permitido === true);

console.log("\n4. Transiciones (el ciclo de docs/08 §1):");
const c1 = trasAjuste(ready0, "cambio");
check("1er cambio: {ready,0} → {ready,1}", c1.estado === "ready" && c1.ajustesUsados === 1);
const c2 = trasAjuste(c1, "cambio");
check("2º cambio: → {ready,2}", c2.estado === "ready" && c2.ajustesUsados === 2);
const c3 = trasAjuste(c2, "cambio");
check("3er cambio (v4, último): → {frozen,3}", c3.estado === "frozen" && c3.ajustesUsados === 3);
const rep = trasAjuste({ estado: "ready", ajustesUsados: 1 }, "reparacion");
check("reparación NO consume ni cambia el ciclo", rep.estado === "ready" && rep.ajustesUsados === 1);

console.log("\n5. Congelado voluntario ('esta ya quedó'):");
const cong = congelar({ estado: "ready", ajustesUsados: 1 });
check("ready con ajustes libres → frozen (voluntario)", cong.estado === "frozen" && cong.ajustesUsados === 1);
check("congelar es idempotente", congelar(cong).estado === "frozen");

console.log("\n6. Simulación de punta a punta:");
let ciclo: Ciclo = { estado: "ready", ajustesUsados: 0 };
let versiones = 1; // v1
for (let i = 0; i < 5; i++) {
  const d = puedeAjustar(ciclo, "cambio");
  if (d.permitido) { ciclo = trasAjuste(ciclo, "cambio"); versiones++; }
}
check("máx 4 versiones (v1 + 3 cambios), luego se detiene", versiones === MAX_AJUSTES + 1 && ciclo.estado === "frozen");
check("una reparación tras congelar sigue permitida", puedeAjustar(ciclo, "reparacion").permitido === true);

console.log(`\n${ok ? "✓ CICLO DE VIDA (máquina de estados) PROBADO" : "✗ FALLÓ"} — 3 ajustes, cambio≠reparación, congelado.`);
process.exit(ok ? 0 : 1);
