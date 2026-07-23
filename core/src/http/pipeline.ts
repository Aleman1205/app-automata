import { type Pool } from "pg";
import { conOrg } from "../db/pg.ts";
import { assertCan, necesitaStepUp, NoAutorizado, type Accion, type Membresia } from "../auth/roles.ts";
import { leerMembresia } from "../auth/membresia.ts";
import { CuotaExcedida } from "../billing/cuota.ts";
import { type Contexto, type Esquema, type Metodo, type RateLimiter, type Respuesta, type Sesion, type Solicitud, R } from "./tipos.ts";

// El ÚNICO camino para un handler CON EFECTO. Compone las 8 capas de docs/13 §3,
// fail-CLOSED en cada una. Orden (corrección de la revisión adversarial):
//   0 rate → 1 authn (JWT Clerk) → método(405) → 2 CSRF → 3 org de la ruta →
//   [conOrg: 6 membresía VIVA → 7 assertCan → 5 step-up → 4 validación → handler]
// La autorización (membresía+rol) va ANTES de step-up y validación: un no-miembro
// recibe 403 uniforme y no puede enumerar esquemas ni provocar prompts de MFA. El
// handler corre DENTRO de conOrg: su lectura de rol y sus escrituras comparten la
// misma tx RLS-acotada. Traduce NoAutorizado→403 y CuotaExcedida→402.

const MUTANTES = new Set<string>(["POST", "PUT", "PATCH", "DELETE"]);
const VENTANA_STEPUP_MS = 5 * 60 * 1000; // el MFA debe haberse re-verificado hace ≤5 min

export interface Deps {
  pool: Pool;
  sesion: Sesion;
  rate: RateLimiter;
  ahora?: () => number; // inyectable para tests deterministas
}

export interface Endpoint<T> {
  nombre: string; // "POST /orgs/:orgId/automatizaciones"
  metodo: Metodo; // el verbo esperado; withEfecto lo verifica (defensa en profundidad)
  accion: Accion; // qué hace → assertCan + step-up
  esquema: Esquema<T>;
  handler: (ctx: Contexto<T>) => Promise<Respuesta>;
}

export function withEfecto<T>(ep: Endpoint<T>, deps: Deps): (s: Solicitud) => Promise<Respuesta> {
  const ahora = deps.ahora ?? Date.now;
  return async (s) => {
    // 0. rate-limit (por IP saneada; cae a token/anon).
    const clave = s.ip ?? s.sesionToken ?? "anon";
    if (!(await deps.rate.permitir(clave))) return R.rate();

    // 1. authn — Clerk verifica el JWT en el SERVIDOR; sin identidad válida → 401.
    const identidad = await deps.sesion.autenticar(s);
    if (!identidad) return R.noAutenticado();

    // método declarado (no depender solo del ruteo de Next).
    if (s.metodo !== ep.metodo) return R.metodoNoPermitido();

    // 2. CSRF — TODA mutación debe venir de nuestro origen. Fail-closed: si falta el
    //    Origin o el host esperado, se NIEGA (no se salta la capa).
    if (MUTANTES.has(s.metodo)) {
      if (s.origen === undefined || s.hostEsperado === undefined || s.origen !== s.hostEsperado) {
        return R.prohibido("csrf_origen");
      }
    }

    // 3. org de la ruta (nunca del cuerpo).
    const orgId = s.orgId;
    if (!orgId) return R.malParametro("falta orgId");

    // 4-7. dentro de conOrg (RLS acotado): membresía VIVA → assertCan → step-up → validación → handler.
    try {
      return await conOrg(deps.pool, orgId, async (c) => {
        // 6-7. autorización primero: sin fila → no es miembro (cross-org/ex) → 403; rol insuficiente → 403.
        const membresia = await leerMembresia(c, identidad.userId);
        assertCan(membresia, orgId, ep.accion);

        // 5. step-up MFA para acciones peligrosas (docs/13 §1). Doble cota: un
        //    mfaVerificadoEn en el FUTURO (clock-skew/claim manipulado) NO cuenta.
        if (necesitaStepUp(ep.accion)) {
          const t = identidad.mfaVerificadoEn?.getTime();
          const dt = t === undefined ? undefined : ahora() - t;
          if (dt === undefined || dt < 0 || dt > VENTANA_STEPUP_MS) return R.stepUp();
        }

        // 4. validación de entrada (allowlist por endpoint).
        const parsed = ep.esquema.analizar(s.cuerpo);
        if (!parsed.ok) return R.malParametro(`entrada_invalida: ${parsed.problemas.join(", ")}`);

        return ep.handler({ identidad, membresia: membresia as Membresia, orgId, input: parsed.valor, cliente: c });
      });
    } catch (e) {
      if (e instanceof NoAutorizado) return R.prohibido(e.message);
      if (e instanceof CuotaExcedida) return R.cuota(e.message);
      throw e; // inesperado → el adaptador lo mapea a 500 sin filtrar stack (nunca a 200)
    }
  };
}
