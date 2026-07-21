import Anthropic from "@anthropic-ai/sdk";
import { SISTEMA_INTAKE, mensajeTurno } from "./prompt.ts";
import { validarSpec } from "./validator.ts";
import {
  type Pregunta,
  type RespuestaRonda,
  type ResultadoIntake,
  type TurnoResultado,
  toolsDelTurno,
} from "./schema.ts";

// El entrevistador (docs/10). NO es una sesión de CMA: son llamadas directas a la
// API de Sonnet con salida estructurada por tool, restringida por turno (§2).
// Presupuesto de cierre: 3 reintentos con feedback del validador; al agotarse,
// se acepta el último spec con confianza "baja" (§4) — nunca se deja colgado.

const MODELO = "claude-sonnet-5";
const MAX_TOKENS = 2048;
const REINTENTOS_CIERRE = 3;

export type AutoResponder = (preguntas: Pregunta[]) => RespuestaRonda[];

/** AutoResponder por defecto: elige la opción recomendada (o la primera). */
export const elegirRecomendada: AutoResponder = (preguntas) =>
  preguntas.map((p) => {
    const rec = p.opciones.find((o) => o.recomendada) ?? p.opciones[0];
    return { pregunta_id: p.id, opcion_id: rec?.id ?? null };
  });

export class IntakeAgent {
  private client = new Anthropic();

  /** Un turno: una llamada a Sonnet con los tools permitidos del turno. */
  async turno(
    idea: string,
    historial: { pregunta: string; respuesta: string }[],
    turno: number,
  ): Promise<TurnoResultado> {
    const tools = toolsDelTurno(turno) as any;
    let feedback = "";

    for (let intento = 0; intento <= REINTENTOS_CIERRE; intento++) {
      const resp: any = await this.client.messages.create({
        model: MODELO,
        max_tokens: MAX_TOKENS,
        system: SISTEMA_INTAKE,
        messages: [{ role: "user", content: mensajeTurno(idea, historial, turno) + feedback }],
        tools,
        tool_choice: { type: "any" },
      });

      const bloque = (resp.content ?? []).find((b: any) => b.type === "tool_use");
      if (!bloque) throw new Error("El modelo no llamó ningún tool.");
      const input = bloque.input;

      if (bloque.name === "rechazar") {
        return { accion: "rechazar", viabilidad: input.viabilidad, motivo_interno: input.motivo_interno };
      }
      if (bloque.name === "preguntar") {
        return {
          accion: "preguntar",
          viabilidad: input.viabilidad,
          reencuadre: input.reencuadre ?? null,
          preguntas: input.preguntas,
        };
      }

      // cerrar → valida el spec (§4).
      const spec = input.spec;
      const v = validarSpec(spec);
      if (!v.ok && intento < REINTENTOS_CIERRE) {
        feedback = `\n\nEl spec no pasó validación: ${v.errores.join("; ")}. Corrígelo y vuelve a cerrar.`;
        continue;
      }
      if (!v.ok) {
        // Presupuesto agotado: se acepta con confianza baja y las fallas a la vista (§4).
        spec.confianza = "baja";
        spec.ambiguedades_restantes = [...(spec.ambiguedades_restantes ?? []), ...v.errores];
      }
      return { accion: "cerrar", viabilidad: input.viabilidad, spec, saludo: input.saludo };
    }
    throw new Error("Presupuesto de reintentos de cierre agotado sin resultado.");
  }

  /**
   * Entrevista completa, no interactiva: corre turnos 1→3, respondiendo las
   * preguntas con `responder` (por defecto, la opción recomendada). Devuelve el
   * cierre (spec) o el rechazo. El turno 3 fuerza el cierre.
   */
  async entrevistar(idea: string, responder: AutoResponder = elegirRecomendada): Promise<ResultadoIntake> {
    const historial: { pregunta: string; respuesta: string }[] = [];
    for (let turno = 1; turno <= 3; turno++) {
      const res = await this.turno(idea, historial, turno);
      if (res.accion !== "preguntar") return res;
      const respuestas = responder(res.preguntas);
      for (const p of res.preguntas) {
        const r = respuestas.find((x) => x.pregunta_id === p.id);
        const opcion = p.opciones.find((o) => o.id === r?.opcion_id);
        historial.push({ pregunta: p.titulo, respuesta: r?.otro ?? opcion?.etiqueta ?? "(sin respuesta)" });
      }
    }
    throw new Error("El intake no cerró tras el turno 3 (no debería ocurrir).");
  }
}
