import Anthropic from "@anthropic-ai/sdk";
import { SISTEMA_INTAKE, mensajeTurno, type EntradaHistorial } from "./prompt.ts";
import { validarSpec } from "./validator.ts";
import {
  type Pregunta,
  type RespuestaRonda,
  type ResultadoIntake,
  type TurnoResultado,
  toolsDelTurno,
} from "./schema.ts";

// El entrevistador (docs/10). NO es una sesión de CMA: llamadas directas a Sonnet
// con salida estructurada por tool, restringida por turno (§2). Presupuesto de
// cierre: 3 reintentos con feedback; al agotarse, si el spec sigue estructuralmente
// inválido NO se emite (§4/§8: solo el spec validado fluye aguas abajo).

const MODELO = "claude-sonnet-5";
const MAX_TOKENS = 2048;
const REINTENTOS_CIERRE = 3;

export class IntakeError extends Error {}

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
  async turno(idea: string, historial: EntradaHistorial[], turno: number): Promise<TurnoResultado> {
    const tools = toolsDelTurno(turno) as any;
    let feedback = "";

    for (let intento = 0; intento <= REINTENTOS_CIERRE; intento++) {
      const ultimo = intento >= REINTENTOS_CIERRE;
      const resp: any = await this.client.messages.create({
        model: MODELO,
        max_tokens: MAX_TOKENS,
        system: SISTEMA_INTAKE,
        messages: [{ role: "user", content: mensajeTurno(idea, historial, turno) + feedback }],
        tools,
        tool_choice: { type: "any" },
      });

      const bloque = (resp.content ?? []).find((b: any) => b.type === "tool_use");
      if (!bloque) {
        if (ultimo) throw new IntakeError("El modelo no llamó ningún tool.");
        feedback = "\n\nDebes llamar exactamente un tool de los permitidos.";
        continue;
      }
      const nombre = bloque.name;
      const input = bloque.input ?? {};

      if (nombre === "rechazar") {
        if (typeof input.motivo_interno !== "string") {
          if (ultimo) throw new IntakeError("rechazar sin motivo_interno.");
          feedback = "\n\nrechazar debe incluir motivo_interno.";
          continue;
        }
        return { accion: "rechazar", viabilidad: input.viabilidad, motivo_interno: input.motivo_interno };
      }

      if (nombre === "preguntar") {
        if (!Array.isArray(input.preguntas) || input.preguntas.length === 0) {
          if (ultimo) throw new IntakeError("preguntar sin preguntas.");
          feedback = "\n\npreguntar debe incluir un arreglo de preguntas.";
          continue;
        }
        return { accion: "preguntar", viabilidad: input.viabilidad, reencuadre: input.reencuadre ?? null, preguntas: input.preguntas };
      }

      if (nombre === "cerrar") {
        const spec = input.spec; // validarSpec guarda contra ausente/no-objeto
        let v = validarSpec(spec);
        if (!v.ok && !ultimo) {
          feedback = `\n\nEl spec no pasó validación: ${v.errores.join("; ")}. Corrígelo y vuelve a cerrar.`;
          continue;
        }
        if (!v.ok) {
          // Último intento: repara SOLO lo reparable (confianza baja sin ambigüedades).
          if (spec && typeof spec === "object" && spec.confianza === "baja" && (spec.ambiguedades_restantes?.length ?? 0) === 0) {
            spec.ambiguedades_restantes = ["Quedaron detalles por confirmar en la aprobación."];
            v = validarSpec(spec);
          }
          if (!v.ok) {
            // Fallas estructurales que no se reparan: NO emitir un spec roto al build.
            throw new IntakeError(`No se pudo cerrar con un spec válido tras ${REINTENTOS_CIERRE + 1} intentos: ${v.errores.join("; ")}`);
          }
        }
        return { accion: "cerrar", viabilidad: input.viabilidad, spec, saludo: input.saludo ?? "" };
      }

      // Tool desconocido (no debería, por tool_choice, pero defensivo).
      if (ultimo) throw new IntakeError(`Tool inesperado: ${nombre}`);
      feedback = `\n\nSolo puedes usar: ${(tools as any[]).map((t) => t.name).join(", ")}.`;
    }
    throw new IntakeError("Presupuesto de reintentos de cierre agotado.");
  }

  /**
   * Entrevista completa, no interactiva: corre turnos 1→3, respondiendo con
   * `responder` (por defecto, la opción recomendada). Devuelve cierre o rechazo.
   */
  async entrevistar(idea: string, responder: AutoResponder = elegirRecomendada): Promise<ResultadoIntake> {
    const historial: EntradaHistorial[] = [];
    for (let turno = 1; turno <= 3; turno++) {
      const res = await this.turno(idea, historial, turno);
      if (res.accion !== "preguntar") return res;
      const respuestas = responder(res.preguntas);
      for (const p of res.preguntas) {
        const r = respuestas.find((x) => x.pregunta_id === p.id);
        const opcion = p.opciones.find((o) => o.id === r?.opcion_id);
        if (r?.otro && !opcion) {
          // Texto libre del cliente: dato hostil, se marca como tal (no autoridad).
          historial.push({ pregunta: p.titulo, eleccion: r.otro, libre: true });
        } else {
          historial.push({ pregunta: p.titulo, eleccion: opcion?.etiqueta ?? "(sin respuesta)", libre: false });
        }
      }
    }
    throw new IntakeError("El intake no cerró tras el turno 3 (no debería ocurrir).");
  }
}
