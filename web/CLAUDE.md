@AGENTS.md

# Front de Automata (prototipo)

Contexto del proyecto completo: `../CLAUDE.md`. Lo esencial para el front:

- **Es 100% demo.** Datos falsos en `lib/datos.ts`, sin backend. Los
  formularios y botones animan pero no guardan ni envían nada.
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
- La marca "Automata" es provisional — está en `lib/marca.ts`.
