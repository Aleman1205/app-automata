// Pill de estado — el SEMÁFORO de las tablas de resultado. Siempre con texto (nunca color solo):
// un daltónico tiene que poder leerlo, y una impresión en blanco y negro también.
//
// Tres estados, no dos. Antes había `ok` (oliva) y `alerta` (ladrillo) y todo lo demás caía en
// `neutro` gris. Eso obliga a decidir entre "bien" y "mal" cosas que en un reporte contable son
// justamente el caso intermedio: "con tolerancia", "en tránsito", "pendiente de cobro". Ahora
// `revisar` (ámbar) las nombra, que es lo que el cliente espera de un semáforo.
const TONOS: Record<TonoEstado, string> = {
  ok: "bg-oliva/12 text-oliva",
  revisar: "bg-ambar/16 text-ambar",
  alerta: "bg-ladrillo/12 text-ladrillo",
  neutro: "bg-tinta/8 text-sepia",
};

// El VOCABULARIO no se define aquí: vive en `core/src/vista/formato.ts`, que es donde hay
// corredor de pruebas (`verify:formato`). Decidir si "conciliado" se ve verde o gris cambia lo
// que el cliente entiende de su reporte, y eso no puede quedar suelto en un componente sin un
// solo test — que es exactamente como estaba, con dos regex que dejaban "conciliado" en GRIS.
// El tipo también viene de ahí: si el core suma un tono y este mapa no lo tiene, `tsc` lo caza
// aquí en vez de dejar una celda sin color en producción.
import { tonoDeEstado, type TonoEstado } from "automata-core/vista/formato";
export { tonoDeEstado as tonoDeTexto };

export type Tono = TonoEstado;

export function Insignia({
  texto,
  tono,
}: {
  texto: string;
  tono?: Tono;
}) {
  const t = tono ?? tonoDeEstado(texto);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${TONOS[t]}`}
    >
      {texto}
    </span>
  );
}
