# core — el motor del producto (Fase 1)

El loop **build → artefacto → run → vista** en TypeScript, framework-agnóstico.
Es la rebanada M0 del plan (`docs/plan-fase-1.md`): probar el loop en nuestra
infra antes de meter auth/billing/UI (eso es M2+).

## Qué prueba M0

- **Build:** un spec → CMA construye el artefacto (código + manifiesto). Lifteado
  del spike ya probado, con la config de la decisión (b): deps pre-horneadas +
  `networking: limited` (build sin red). `src/cma/build.ts`.
- **Artefacto:** se guarda en `Storage` (local FS en M0; R2 en prod).
- **Run:** ejecuta el artefacto sobre el insumo — **código puro, sin modelo**.
  `src/run/executor.ts`.
- **Vista:** el `resolver` aterriza `vista.json` (referencias `@resultado.*`)
  sobre el resultado del Run → un `Resultado` (los mismos bloques que el front
  renderiza). Es la primera vez que se ejerce el contrato de docs/09.

## Puertos (intercambiables)

`src/types.ts` define interfaces para cambiar implementación sin tocar llamadores:
`Storage` (local ↔ R2), `StateRepo` (memoria ↔ Neon), `BuildClient` (CMA ↔ runner
propio), `RunExecutor`.

## Correr

```bash
cd core && npm install

npm run typecheck        # TypeScript
npm run verify           # prueba GRATIS run→vista con el artefacto del spike ($0, sin modelo)
npm run m0               # el loop completo (reusa el artefacto del spike)
npm run m0 -- --build    # construye de verdad en CMA (~$2, ~10 min, necesita API key)
```

`npm run verify` reutiliza `spike/salidas/dashboard-popularidad/automatizacion.py`
y `spike/datos/gastos.xlsx`. Si faltan: `npm run datos:vitrales` en la raíz (y/o
correr el spike).

## Lo que NO es M0 (siguientes milestones)

Auth/multitenancy (M2), billing/cuotas (M3), ciclo de vida + validación de inputs
hostiles (M4), catálogo + switch multi-input (M5). Ver `docs/plan-fase-1.md`.
