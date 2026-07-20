# Lectura de mercado — base de 190 ideas de micro-SaaS (Starter Story)

> Análisis de `Micro-SaaS Ideas Database [Starter Story].xlsx` (190 ideas con
> revenue, costo inicial, "solopreneur score", ICP y tácticas de crecimiento).
> Fuente **global/EUA, en USD**. Es evidencia **indirecta y direccional** — no
> sustituye validar con clientes reales (riesgo abierto #2). Fecha: 2026-07-20.

## Los números de la base

- 190 ideas; 174 con revenue. **Mediana $39,600/mes**, media $156K (sesgada por
  outliers hasta $2.7M). No son juguetes: son negocios reales.
- Costo inicial: mediana $7,500, pero **23% arrancan con ≤$100**. Barrera baja
  confirmada para un lanzamiento tipo solopreneur.
- "Solopreneur score" mediana 72/95 — la mayoría son manejables por equipos
  chicos.

## Qué VALIDA para Automata

### 1. El núcleo (datos → reporte/dashboard) es un negocio probado

Análogos casi directos, rentables y de **costo inicial casi nulo**:

| Idea | Revenue/mes | Costo inicial | ICP |
|---|---|---|---|
| **Automated reporting platform** | $287K | **$0** | Entrepreneurs, Consultants, Professional Service Firms |
| **Data Aggregation And Visualisation** | $167K | $250K | Developers, Business Teams, Operations, SMBs |
| Rapid/secure embedded analytics | $225K | $0 | SaaS, Retail, Healthcare |

"Automated reporting platform" es prácticamente Automata en EUA: convertir datos
en reportes, sin código, para no-técnicos. **$287K/mes con $0 de arranque.** La
*forma* del producto funciona.

### 2. Refuerza el pivote de inputs "más allá del Excel"

Justo lo que estábamos discutiendo. Por categoría (ideas · revenue mensual sumado):

| Categoría | Ideas | Revenue/mes |
|---|---|---|
| Contenido / IA generativa | 37 | $5.3M |
| Automatización / flujos | 25 | $1.5M |
| **Documentos / PDF / extracción** | **23** | **$2.35M** |
| Correo / CRM / clientes | 19 | $2.29M |
| Inventario / e-commerce ops | 19 | $1.0M |
| Datos / reportes / dashboards | 15 | $1.6M |

**La extracción de documentos/PDF es una categoría de $2.35M/mes.** Confirma que
diversificar los inputs (PDF, fotos de tickets, formularios) no es capricho: ahí
hay dinero. Nuestro "caso 1" (otro input, mismo patrón a demanda) está validado
por el mercado.

## El CAVEAT grande: el ICP no es nuestro ICP

Los ganadores de esta base apuntan a **SMBs digitales**, no a la PyME tradicional
mexicana. ICP más comunes:

| ICP | Frecuencia |
|---|---|
| Entrepreneurs | 67 |
| Small Business Owners | 55 |
| Startup Founders | 49 |
| SMBs | 39 |
| Ecommerce Sellers | 20 |
| Freelancers / Agencies | 18 / 13 |

Casi nadie es "hotel", "restaurante" ni "despacho". Son fundadores, agencias,
tiendas online, SaaS — clientes **nativos digitales que buscan software solos**.
Nuestro target (hoteles/restaurantes/despachos MX) es más analógico. Implicación:
podemos **copiar el producto, no la ida al mercado**.

## Playbook de crecimiento (y cómo adaptarlo)

Tácticas dominantes en la base: **SEO (124), word of mouth (121)**, redes
orgánicas (67), venta directa (56), email (52).

Pero SEO domina porque sus ICPs **googlean soluciones**. Una PyME tradicional
mexicana no busca "software de reportes" en Google. Para nuestro target manda:
- **Venta directa** (56 en la base) — tocar puertas, demos en persona.
- **Word of mouth / referidos** (121 + 38) — el dueño de un hotel le cuenta a otro.
- SEO/contenido: apuesta de largo plazo, no el motor inicial.

## Roadmap de expansión (categorías adyacentes probadas)

Orden sugerido por cercanía a lo que ya hace el motor (archivo → proceso →
resultado, sin estado):

1. **Extracción de documentos** (PDF/fotos → tabla) — $2.35M/mes, encaja directo.
2. **Consolidación/reportes de datos** — el núcleo, ya validado.
3. **Inventario / e-commerce ops** — $1M/mes, para PyMEs con tienda.
4. Correo/CRM, automatización de flujos — pisan "estado" e "integraciones"
   (Fase 3), tratar con cuidado.

Contenido/IA generativa es la categoría más grande ($5.3M) **pero usa modelos en
el Run** — rompe la decisión de arquitectura (el Run no usa modelos). Es otro
producto; anotarlo, no perseguirlo ahora.

## Qué NO prueba

- Es EUA/global y nativos digitales. **No dice que un hotel en Monterrey pagará
  $499 MXN.** Eso sigue siendo el riesgo abierto #2 (enseñar el prototipo a 5
  clientes reales).
- Revenues en USD con ICPs que pagan en dólares. Nuestro pricing en MXN es otra
  realidad.
- Sesga a herramientas de marketing/dev/contenido; el back-office financiero
  (facturas/nómina/contabilidad) está **subrepresentado** aquí — puede ser hueco
  desatendido (bueno para nosotros) o señal de que es menos "micro-SaaS sexy".

## En una línea

La base confirma que **el producto (datos/documentos → reporte, sin código, para
no-técnicos) es un negocio real y rentable**, y que **diversificar inputs más
allá del Excel es donde está el dinero**. Lo que NO valida es que nuestro ICP
específico (PyME tradicional MX) pague — y encima avisa que su forma de llegar al
cliente es venta directa + referidos, no SEO.
