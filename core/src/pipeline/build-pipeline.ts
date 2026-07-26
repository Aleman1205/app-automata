import type {
  Artefacto,
  BuildClient,
  BuildClientAsync,
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
import { gatearEjemplo, gatearInputs, type MetaEntrada } from "../entrada/puente.ts";

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
  args: { orgId: string; nombre: string; spec: Spec; vista: Vista; ejemploPath: string; ejemploExt?: string; contratoTexto?: string },
): Promise<{ version: Version; artefacto: Artefacto; costoUsd: number; iteraciones: number }> {
  // GATE de entrada (a4): valida el ejemplo ANTES de consumir un espacio del plan o subir
  // nada a CMA. Lanza EntradaRechazada (hostil) / EntradaEnRevision (ilegible). La extensión
  // sale del meta declarado; en M0 se deriva del path. Va lo PRIMERO: no se cobra por hostil.
  await gatearEjemplo(args.ejemploPath, { nombre: args.nombre, extension: args.ejemploExt });
  // crearAutomatizacion COMMITea con activa=true (consume un espacio del plan). Si algo
  // posterior falla, la automatización queda activa SIN build → agotaría los espacios y
  // ladrillaría la org (el rol de app no puede borrarla). Por eso todo lo que sigue va en
  // un try que COMPENSA desactivándola (devuelve el espacio) ante cualquier fallo.
  const auto = await deps.state.crearAutomatizacion({ orgId: args.orgId, nombre: args.nombre });
  try {
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
      ({ codigo, costoUsd, iteraciones, aprobado } = await deps.build.build(args.spec, args.ejemploPath, args.contratoTexto));
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
  } catch (e) {
    // Compensación (no enmascara el error original si ella misma falla).
    await deps.state.desactivarAutomatizacion(auto.id).catch(() => {});
    throw e;
  }
}

/** Build-start ASÍNCRONO (a3): la versión analoga de `construir` para producción. Gatea el
 *  ejemplo, RESERVA la versión 'building' con la vista (cobrar_build cobra la generación),
 *  ARRANCA la sesión de CMA y graba su id (write-once). NO espera: el webhook encola y el
 *  drainer cosecha. Compensa (desactiva la automatización) ante cualquier fallo del arranque. */
export async function arrancarConstruccion(
  deps: { state: StateRepo; cosechador: BuildClientAsync; ahora: () => string },
  args: { orgId: string; nombre: string; spec: Spec; vista: Vista; ejemploPath: string; ejemploExt?: string; contratoTexto?: string },
): Promise<{ version: Version; sessionId: string }> {
  await gatearEjemplo(args.ejemploPath, { nombre: args.nombre, extension: args.ejemploExt }); // a4
  const auto = await deps.state.crearAutomatizacion({ orgId: args.orgId, nombre: args.nombre });
  try {
    // RESERVA antes de gastar: crear la versión (cobrar_build) ANTES de abrir la sesión de CMA.
    const version = await deps.state.crearVersion({ automatizacionId: auto.id, numero: 1, estado: "building", vista: args.vista, creada: deps.ahora() });
    let sessionId: string;
    try {
      ({ sessionId } = await deps.cosechador.arrancar(args.spec, args.ejemploPath, args.contratoTexto));
    } catch (e) {
      await deps.state.actualizarVersion(version.id, { estado: "failed" });
      throw e;
    }
    await deps.state.fijarSesionCma(version.id, sessionId); // write-once vía el SD
    return { version, sessionId };
  } catch (e) {
    await deps.state.desactivarAutomatizacion(auto.id).catch(() => {});
    throw e;
  }
}

/** Ejecuta un artefacto sobre insumos y devuelve el Resultado ya resuelto. */
export async function ejecutar(
  deps: Deps,
  args: { version: Version; inputs: Record<string, string>; metas?: Record<string, MetaEntrada> },
): Promise<{ resultado: Resultado; datos: unknown; ejecucion: Ejecucion; ms: number }> {
  if (!args.version.artefactoKey) {
    throw new Error("La versión no tiene artefacto (¿el build terminó bien?).");
  }
  // GATE de entrada (a4): valida el SOBRE de insumos ANTES de reservar la ejecución y de
  // correr el código de IA. Hostil → EntradaRechazada; ilegible → EntradaEnRevision (no
  // corre). NOTA (follow-up): cuando el run se exponga por HTTP, llamar verificar_freno
  // ANTES de esto para no inflar zips grandes delante del kill-switch (DoS).
  await gatearInputs(args.inputs, args.metas);
  // Carga el artefacto desde el Storage por su clave. Ejerce el hop
  // artefacto→Storage→run de ida y vuelta: en producción, build y run son steps
  // separados de Inngest y el run NO tiene el objeto en memoria (docs/03).
  // La clave se RECOMPUTA de version.id (determinista), NO se lee de version.artefactoKey:
  // con el rol de app escribible (GRANT UPDATE(artefacto_key)) y el Storage sin org-scope,
  // confiar en la columna dejaría a un app comprometido apuntar al artefacto de otra org.
  // version.id solo se obtiene de la propia org (RLS), así que es una clave segura.
  const artefacto = JSON.parse(await deps.storage.getText(artefactoKey(args.version.id))) as Artefacto;

  // RESERVA→CORRE→CONFIRMA: el asiento en `ejecuciones` se crea ANTES de correr el
  // código de IA. En Postgres ese INSERT dispara trg_kill_run (y con RLS lo hace en
  // contexto de la org): si ejecuciones está congelado o la org suspendida, el run se
  // ABORTA ANTES de ejecutar nada (docs/11 §10). Correr-primero-registrar-después
  // dejaba el freno llegando tarde: el código peligroso ya había corrido (revisión).
  const reserva = await deps.state.crearEjecucion({
    versionId: args.version.id,
    estado: "reservada",
    ms: 0,
    costoUsd: 0,
    creada: deps.ahora(),
  });

  let datos: unknown, ms: number, costoUsd: number;
  try {
    ({ resultado: datos, ms, costoUsd } = await deps.run.run(artefacto, args.inputs));
  } catch (e) {
    await deps.state.actualizarEjecucion(reserva.id, { estado: "fallo" });
    throw e;
  }

  // La vista se aterriza sobre los datos crudos (aquí está la puerta de calidad).
  const resultado = resolverVista(artefacto.vista, datos);

  const ejecucion = await deps.state.actualizarEjecucion(reserva.id, { estado: "ok", ms, costoUsd });

  return { resultado, datos, ejecucion, ms };
}
