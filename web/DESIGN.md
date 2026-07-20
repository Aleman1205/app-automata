# Sistema de diseño — prototipo Automata

Referencias del cliente: foto vintage sepia (paleta), SYMBOLSTUDIO (layout de
landing, texto gigante), topbar de píldora oscura con resaltado deslizante,
portfolio minimal (página de detalle), LIQUID (tipografía display enorme).

Objetivo: **limpio, sencillo, atractivo, fácil de navegar, y con animación en
todo** — textos, botones, scroll, tarjetas. Sin marear: micro-animaciones
elegantes, nunca circo.

---

## 1. Paleta (tokens Tailwind — usa SIEMPRE los tokens, nunca hex sueltos)

| Token | Hex | Uso |
|---|---|---|
| `crema` | #EFE8D8 | Fondo global |
| `papel` | #F6F1E3 | Paneles, secciones alternas, fondo del pie |
| `hueso` | #FBF8EF | Tarjetas, superficies elevadas, texto sobre oscuro |
| `tinta` | #1D1710 | Texto principal, barras de gráficas |
| `noche` | #16110B | Nav, tarjeta destacada de precios, sección CTA oscura |
| `sepia` | #7C6F5C | Texto secundario, etiquetas mono |
| `linea` | #DCD3BE | Bordes, divisores, grid |
| `acento` | #FF4D00 | **SOLO botones de acción principal** (variante `acento` de `Boton`) y el punto de la marca. Nada más: ni títulos, ni iconos decorativos, ni fondos. |
| `oliva` | #6B7C3F | Estado "lista" / éxito. Siempre con texto o icono. |
| `ladrillo` | #A8432B | Estado "no se pudo". Siempre con texto o icono. |

**Gráficas: SIEMPRE de una sola serie** (barras `tinta`). Prohibido inventar
gráficas multi-serie: la paleta de estados NO está validada como paleta
categórica. Usa el componente `GraficaBarras`, nunca recharts directo.

## 2. Tipografía

- Sans: Archivo (`font-sans`, ya global). Mono: IBM Plex Mono (`font-mono`).
- Display gigante: `text-[11vw] font-black uppercase tracking-[-0.03em] leading-[0.85]`
- H1: `text-5xl md:text-7xl font-black tracking-tight leading-[0.95]`
- H2: `text-3xl md:text-5xl font-black tracking-tight`
- Cuerpo: `text-base md:text-lg`, secundario en `text-sepia`, `leading-relaxed`
- Micro-etiquetas: usa `<Etiqueta>` (mono, uppercase, tracking amplio)
- Números siempre `tabular-nums` (los componentes ya lo hacen)

## 3. Layout

- Contenedor: `mx-auto max-w-6xl px-6`
- Secciones: `py-24 md:py-32`. **Primera sección de cada página: `pt-36 md:pt-44`**
  (el topbar es fijo y no tiene fondo).
- Divisores y "grid de líneas" (ref. SYMBOLSTUDIO): `border-linea`
- Radios: tarjetas `rounded-2xl`, botones/pills `rounded-full`
- Desktop primero; en móvil basta con apilar (`grid md:grid-cols-…`)

## 4. Catálogo de componentes (imports exactos)

```tsx
import { Boton } from "@/components/ui/boton";
// <Boton variante="acento|oscuro|fantasma" tamano="sm|md|lg" href? onClick?
//        icono="flecha|diagonal|descarga|mas|play|reintentar|check"
//        deshabilitado? magnetico?>Texto</Boton>
// REGLA: exactamente UN botón acento visible por pantalla (la acción principal).

import { Tarjeta } from "@/components/ui/tarjeta";
// <Tarjeta interactiva? tilt? className? onClick?>…</Tarjeta>
// interactiva = se eleva al hover · tilt = inclinación 3D sutil

import { Etiqueta } from "@/components/ui/etiqueta";      // <Etiqueta punto?>TEXTO</Etiqueta>
import { Estado } from "@/components/ui/estado";          // <Estado estado={a.estado} />
import { PuntosAjustes } from "@/components/ui/puntos-ajustes"; // usados, total?, conTexto?, tamano?
import { Metrica } from "@/components/ui/metrica";        // etiqueta, valor, formato, nota?
import { GraficaBarras } from "@/components/ui/grafica-barras"; // datos, formato, alto?
import { Tabla } from "@/components/ui/tabla";            // columnas, filas
import { Acordeon } from "@/components/ui/acordeon";      // items: {pregunta, respuesta}[]
import { useAviso } from "@/components/ui/aviso";         // const { avisar, elemento } = useAviso()

import { Reveal } from "@/components/motion/reveal";           // retraso?, y?, className?
import { TextoRevelado } from "@/components/motion/texto-revelado"; // texto, como, className, retraso?
import { Contador } from "@/components/motion/contador";       // valor, formato, sufijo?
import { Marquesina } from "@/components/motion/marquesina";   // duracion?, className?
import { Magnetico } from "@/components/motion/magnetico";     // fuerza?
import { CheckDibujado } from "@/components/motion/check-dibujado"; // tamano?
import { MaquinaEscribir } from "@/components/motion/maquina-escribir"; // frases[]
```

Datos falsos: `import { automatizaciones, obtenerAutomatizacion, rondasEntrevista, specResumen, ejemplosIdea, planes, faq, pasosMarquesina } from "@/lib/datos"` y `import { MARCA } from "@/lib/marca"`.

CSS utilitario ya definido en globals: `.esqueleto` (shimmer), `.barra-indeterminada`, `.pista-marquesina` (lo usa Marquesina).

## 5. Reglas de animación (esto es lo que pide el cliente: TODO animado)

1. Todo bloque de contenido entra con `<Reveal>`; en listas/grids, escalona con
   `retraso={i * 0.08}`.
2. Todo H1/H2 importante usa `<TextoRevelado>`.
3. Toda cifra usa `<Contador>` o `<Metrica>`.
4. Botones y tarjetas ya traen su hover — no los envuelvas en más efectos.
5. Cambios de paso/pantalla dentro de una página: `AnimatePresence` de
   `motion/react` con `initial={{opacity:0, x:24}} animate={{opacity:1, x:0}}
   exit={{opacity:0, x:-24}}` y `mode="wait"`.
6. Easing estándar: `[0.22, 1, 0.36, 1]`. Duraciones 0.3–0.7 s. Springs para
   cosas físicas (`stiffness: 300–400, damping: 22–32`).
7. Nada de: parallax agresivo, rotaciones grandes, confeti, cursores custom,
   autoplay con sonido. Elegante y sobrio.

## 6. Convenciones técnicas (Next 16 — OJO, difiere de lo que conoces)

- `"use client"` en todo archivo con hooks/motion. Las páginas de este
  prototipo pueden ser client components completas.
- **Rutas dinámicas: `params` es una Promise.** En una página client:
  `import { use } from "react"; const { id } = use(params);` con tipo
  `{ params: Promise<{ id: string }> }`.
- Imports de motion: `import { motion, AnimatePresence } from "motion/react"`.
- Links con `next/link`. NO usar `next/image` ni imágenes externas: todo
  placeholder visual se hace con divs, gradientes de la paleta y SVG inline.
- Texto de UI: español de México, tuteo, cero jerga técnica (el cliente del
  producto no programa). Nada de "webhook", "CSV parsing", "API".
- No corras `pnpm build` ni `pnpm dev` — la verificación la hace el orquestador.
- Scroll programático: `window.__lenis?.scrollTo(elemento, { offset: -120 })`.

## 7. Propiedad de archivos

**NO toques**: `app/layout.tsx`, `app/template.tsx`, `app/globals.css`,
`components/**`, `lib/**`, `next.config.ts`. Si te falta un componente,
créalo DENTRO de tu carpeta de ruta (p. ej. `app/nueva/componentes/…`).
