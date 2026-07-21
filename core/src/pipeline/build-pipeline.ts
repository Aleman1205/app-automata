import type {
  Artefacto,
  BuildClient,
  CodigoConstruido,
  Ejecucion,
  Resultado,
  RunExecutor,
  Spec,
  StateRepo,
  Storage,
  Version,
  Vista,
} from "../types.ts";
import { resolverVista } from "../vista/resolver.ts";

// El pipeline teje los puertos: build -> guardar artefacto -> run -> resolver
// vista. En producción cada paso es un `step` de Inngest con webhooks (docs/03);
// en M0 corre directo.

export interface Deps {
  storage: Storage;
  state: StateRepo;
  build: BuildClient;
  run: RunExecutor;
  ahora: () => string; // reloj inyectado (el core no usa Date directo)
}

function artefactoKey(versionId: string): string {
  return `artefactos/${versionId}.json`;
}

/** Compone el artefacto (código construido + vista provista) y lo guarda. */
export async function construir(
  deps: Deps,
  args: { orgId: string; nombre: string; spec: Spec; vista: Vista; ejemploPath: string },
): Promise<{ version: Version; artefacto: Artefacto; costoUsd: number; iteraciones: number }> {
  const auto = await deps.state.crearAutomatizacion({ orgId: args.orgId, nombre: args.nombre });
  let version = await deps.state.crearVersion({
    automatizacionId: auto.id,
    numero: 1,
    estado: "building",
    creada: deps.ahora(),
  });

  let codigo: CodigoConstruido;
  let costoUsd: number;
  let iteraciones: number;
  let aprobado: boolean;
  try {
    ({ codigo, costoUsd, iteraciones, aprobado } = await deps.build.build(args.spec, args.ejemploPath));
  } catch (e) {
    await deps.state.actualizarVersion(version.id, { estado: "failed" });
    throw e;
  }
  if (!aprobado) {
    await deps.state.actualizarVersion(version.id, { estado: "failed" });
    throw new Error("El Verifier no aprobó el build.");
  }

  const artefacto: Artefacto = { ...codigo, vista: args.vista };
  const key = artefactoKey(version.id);
  await deps.storage.put(key, JSON.stringify(artefacto));
  version = await deps.state.actualizarVersion(version.id, { estado: "ready", artefactoKey: key });

  return { version, artefacto, costoUsd, iteraciones };
}

/** Ejecuta un artefacto sobre insumos y devuelve el Resultado ya resuelto. */
export async function ejecutar(
  deps: Deps,
  args: { version: Version; inputs: Record<string, string> },
): Promise<{ resultado: Resultado; datos: unknown; ejecucion: Ejecucion; ms: number }> {
  // Carga el artefacto desde el Storage por su clave. Ejerce el hop
  // artefacto→Storage→run de ida y vuelta: en producción, build y run son steps
  // separados de Inngest y el run NO tiene el objeto en memoria (docs/03).
  if (!args.version.artefactoKey) {
    throw new Error("La versión no tiene artefacto (¿el build terminó bien?).");
  }
  const artefacto = JSON.parse(await deps.storage.getText(args.version.artefactoKey)) as Artefacto;

  const { resultado: datos, ms, costoUsd, salidas } = await deps.run.run(artefacto, args.inputs);
  void salidas;

  // La vista se aterriza sobre los datos crudos (aquí está la puerta de calidad).
  const resultado = resolverVista(artefacto.vista, datos);

  const ejecucion = await deps.state.crearEjecucion({
    versionId: args.version.id,
    estado: "ok",
    ms,
    costoUsd,
    creada: deps.ahora(),
  });

  return { resultado, datos, ejecucion, ms };
}
