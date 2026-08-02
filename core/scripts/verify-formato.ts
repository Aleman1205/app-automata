// ─────────────────────────────────────────────────────────────────────────────
// Cómo se LEE el resultado: semáforo y formatos de número (core/src/vista/formato.ts).
//
// Existe porque estas reglas vivían en un componente de `web`, que no tiene corredor de pruebas,
// y decidían algo que el cliente lee como un hecho: si su partida está conciliada o no, y si su
// diferencia es de $0 o de 37 centavos. Ninguna estaba vigilada.
//   npm run verify:formato
// ─────────────────────────────────────────────────────────────────────────────
import { tonoDeEstado, moneda, porcentaje, entero } from "../src/vista/formato.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

console.log("1. Dinero SIEMPRE con centavos (el bug que mostraba un dato falso):");
check("43,199.63 conserva los centavos", moneda(43199.63).includes("43,199.63"));
check("un entero se muestra con .00", moneda(43200).includes("43,200.00"));
// El caso que motivó todo: con redondeo a 0 decimales, esta diferencia se veía como "$0" y el
// reporte afirmaba que la conciliación cuadraba.
check("una diferencia de 0.37 NO se redondea a cero", /0\.37/.test(moneda(0.37)));
check("el negativo conserva el signo y los centavos", /-/.test(moneda(-0.37)) && moneda(-0.37).includes("0.37"));

console.log("\n2. Semáforo VERDE — cerrado y correcto:");
for (const t of ["Conciliado", "Exacto", "Correcto", "Pagado", "Cotejado", "Aplicado", "Completo"]) {
  check(`"${t}" → ok`, tonoDeEstado(t) === "ok");
}

console.log("\n3. Semáforo ÁMBAR — el estado intermedio que ANTES NO EXISTÍA (todo caía en gris):");
for (const t of ["Con tolerancia", "Depósito en tránsito", "Pendiente de cobro", "Revisar", "Parcial", "Baja confianza (OCR)"]) {
  check(`"${t}" → revisar`, tonoDeEstado(t) === "revisar");
}

console.log("\n4. Semáforo ROJO — exige acción:");
for (const t of ["No cuadra", "Sin conciliar", "Rechazado", "Falta el RFC", "Referencia ilegible", "Duplicado", "Cheque sin fondos"]) {
  check(`"${t}" → alerta`, tonoDeEstado(t) === "alerta");
}

console.log("\n5. El orden del vocabulario (aquí se rompía solo):");
// "Sin conciliar" CONTIENE "concili". Si la familia verde se evaluara primero, un descuadre se
// pintaría de verde — el peor error posible en un reporte de conciliación.
check("'Sin conciliar' NO es verde pese a contener 'concili'", tonoDeEstado("Sin conciliar") === "alerta");
check("'No conciliado' NO es verde", tonoDeEstado("No conciliado") === "alerta");
check("'Sin fondos' es rojo, no ámbar por 'sin'", tonoDeEstado("Cheque sin fondos") === "alerta");

console.log("\n6. Lo desconocido se dice de frente:");
// Gris = "no lo reconocimos". Pintarlo de verde haría que el cliente cierre el reporte creyendo
// que todo cuadró; pintarlo de rojo lo alarmaría sin motivo. Ninguna de las dos es honesta.
check("un estado inventado → neutro", tonoDeEstado("Wibble") === "neutro");
check("una celda vacía → neutro", tonoDeEstado("") === "neutro");

console.log("\n7. Porcentaje y entero:");
check("98.4% con un decimal", porcentaje(98.4) === "98.4%");
check("el porcentaje no arrastra basura de flotante", porcentaje(0.1 + 0.2) === "0.3%");
check("entero con separador de miles", entero(1284).includes("1,284"));

console.log(`\n${ok ? "✓ FORMATO DE RESULTADO PROBADO" : "✗ FALLÓ"} — centavos, semáforo de 3 estados y lo desconocido en gris.`);
process.exit(ok ? 0 : 1);
