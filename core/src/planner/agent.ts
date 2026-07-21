import Anthropic from "@anthropic-ai/sdk";
import type { Spec } from "../types.ts";
import { SISTEMA_PLANNER, mensajePlanner } from "./prompt.ts";
import { validarCoherencia } from "./coherencia.ts";
import { TOOL_PLANEAR, type PlanResultado } from "./schema.ts";

// El planner (docs/03/09). Modelo Opus. Produce vista + contrato de resultado,
// y NO devuelve un plan hasta que la puerta de coherencia pasa (toda ref
// @resultado.* respaldada por el contrato). Robusto igual que el intake: valida
// la forma, reintenta con feedback, y lanza si no logra un plan coherente.

const MODELO = "claude-opus-4-8";
const MAX_TOKENS = 4096;
const REINTENTOS = 3;

export class PlannerError extends Error {}

export class PlannerAgent {
  private client = new Anthropic();

  async planear(spec: Spec): Promise<PlanResultado> {
    let feedback = "";
    for (let intento = 0; intento <= REINTENTOS; intento++) {
      const ultimo = intento >= REINTENTOS;
      const resp: any = await this.client.messages.create({
        model: MODELO,
        max_tokens: MAX_TOKENS,
        system: SISTEMA_PLANNER,
        messages: [{ role: "user", content: mensajePlanner(spec) + feedback }],
        tools: [TOOL_PLANEAR] as any,
        tool_choice: { type: "tool", name: "planear" },
      });

      const bloque = (resp.content ?? []).find((b: any) => b.type === "tool_use");
      if (!bloque) {
        if (ultimo) throw new PlannerError("El modelo no llamó la tool 'planear'.");
        feedback = "\n\nDebes llamar la tool 'planear'.";
        continue;
      }
      const input = bloque.input ?? {};

      // Forma mínima antes de usar (el input_schema del modelo es best-effort).
      if (!input.vista || !Array.isArray(input.vista.bloques) || !input.resultado_contrato || !Array.isArray(input.resultado_contrato.campos)) {
        if (ultimo) throw new PlannerError("Plan malformado (falta vista.bloques o resultado_contrato.campos).");
        feedback = "\n\nLa salida debe traer vista.bloques (arreglo) y resultado_contrato.campos (arreglo).";
        continue;
      }

      const plan: PlanResultado = { vista: input.vista, resultado_contrato: input.resultado_contrato };

      // Puerta de coherencia: toda ref @resultado.* debe estar en el contrato.
      const coh = validarCoherencia(plan.vista, plan.resultado_contrato);
      if (!coh.ok) {
        if (ultimo) throw new PlannerError(`Vista incoherente con el contrato: ${coh.errores.join("; ")}`);
        feedback = `\n\nLa vista referencia campos que el contrato no declara (o con tipo equivocado): ${coh.errores.join("; ")}. Corrige el contrato o la vista y vuelve a planear.`;
        continue;
      }

      return plan;
    }
    throw new PlannerError("Presupuesto de reintentos del planner agotado.");
  }
}
