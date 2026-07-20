// Pill de estado. Tono según el sistema: oliva = bien, ladrillo = atención,
// neutro = informativo. Siempre con texto (nunca color solo).

const TONOS = {
  ok: "bg-oliva/12 text-oliva",
  alerta: "bg-ladrillo/12 text-ladrillo",
  neutro: "bg-tinta/8 text-sepia",
} as const;

export type Tono = keyof typeof TONOS;

// Palabras que insinúan urgencia/problema → ladrillo; positivas → oliva.
const ALERTA = /urgente|crítico|critico|agot|vencid|sin |falta|revisar|error|bajo|inválid|invalid/i;
const OK = /al día|al dia|ok|correcto|listo|pagad|completo|sano/i;

export function tonoDeTexto(texto: string): Tono {
  if (ALERTA.test(texto)) return "alerta";
  if (OK.test(texto)) return "ok";
  return "neutro";
}

export function Insignia({
  texto,
  tono,
}: {
  texto: string;
  tono?: Tono;
}) {
  const t = tono ?? tonoDeTexto(texto);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${TONOS[t]}`}
    >
      {texto}
    </span>
  );
}
