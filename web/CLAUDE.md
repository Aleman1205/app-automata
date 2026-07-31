@AGENTS.md

# Front de Nokron (prototipo)

Contexto del proyecto completo: `../CLAUDE.md`. Lo esencial para el front:

- **Demo por defecto, backend real en modo dev.** Sin backend, el front usa datos
  falsos de `lib/datos.ts` (el prototipo, formularios que solo animan). Pero **ya
  consume el backend real** cuando está en modo dev local (`AUTOMATA_DEV_AUTH=1` +
  la org sembrada): portafolio, cuenta, equipo, detalle y el **botón Ejecutar** (que
  corre de verdad) leen/escriben vía `lib/automata/lectura.ts` + las APIs, con
  fallback a `lib/datos.ts`. Runbook: **`../docs/16-modo-dev-local.md`**.
- **Sistema de diseño: `DESIGN.md`** — léelo antes de tocar UI. Paleta sepia
  con tokens (nunca hex sueltos), catálogo de componentes con sus props, reglas
  de animación. El acento naranja es SOLO para la acción principal de cada
  pantalla (un `<Boton variante="acento">` visible por pantalla).
- **Idioma: español de México, tuteo, cero jerga técnica** en toda la UI.
- **Stack:** Next.js 16 (App Router) + pnpm + Tailwind 4 + motion + Recharts.
  Correr: `pnpm dev`. Next 16 difiere de lo conocido — ver `AGENTS.md`.
- **Verificación:** el navegador se congela tras varios scrolls en este
  entorno; verificar por DOM (`javascript_tool`) es más confiable. `pnpm build`
  corre TypeScript y es la señal fiable de que compila.
- La marca es **"Nokron"**. `lib/marca.ts` solo REEXPORTA de `core/src/marca.ts` (fuente única:
  el core la usa en el correo de invitación). Ahí viven también `DOMINIO`, `CORREO_CONTACTO` y
  `CORREO_SOPORTE` — no escribas el nombre ni el dominio a mano en una página.
