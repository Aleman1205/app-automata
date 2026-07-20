# Posicionamiento — Automata no es Zapier

> La respuesta a *"¿esto no es Zapier / Make / n8n?"* — la pregunta que un
> inversionista (o un cliente técnico) va a hacer seguro. Respuesta corta: no,
> es la **categoría opuesta**. Fecha: 2026-07-20.

## De dónde sale esto

Al investigar catálogos de automatización aparecen miles de flujos (n8n: 9,400+
workflows; Zapier: 8,000+ apps; Make: miles de plantillas). Es tentador pensar
"podemos hacer todo eso". **Es una trampa de categoría.** Casi todo ese mundo es
**automatización de integración**, no lo que hace Automata.

## Dos categorías distintas

| | **Zapier / Make / n8n** (integración) | **Automata** |
|---|---|---|
| Qué hace | Conecta apps que **ya tienes** (A → B) | Toma un **desastre** y devuelve un **resultado terminado** |
| Disparador | Eventos, webhooks, cron (corre solo) | **A demanda** — el cliente sube algo y pica un botón |
| Insumo | Apps SaaS ya conectadas | Un archivo, fotos, XML, unos campos |
| Quién lo arma | **Tú** (arrastras nodos) o una plantilla frágil que adaptas | La **IA** lo construye **y lo verifica**; el cliente no ve la plomería |
| Estado | Flujos con estado, sync, persistencia | **Sin estado** (entra → procesa → sale) |
| Cliente | Equipos de ops digitales, cómodos con la técnica | **PyME tradicional, no-técnica** |

## El punto de fondo: el cliente es otro

El cliente de Zapier **ya tiene** Shopify + HubSpot + QuickBooks conectados y
comodidad técnica para cablear nodos. El nuestro —un hotel, un restaurante, un
despacho— tiene un **WhatsApp, un Excel y un fajo de tickets en papel.** No sabe
qué es un webhook y nunca lo va a arrastrar en una pizarra.

Zapier/n8n sirven a quien **ya vive en la nube de apps**. Automata sirve a quien
**está afuera de ella** y se está ahogando en trabajo manual de archivos. No
competimos por el mismo cliente.

## La diferencia de mecanismo (y por qué gana con nuestro cliente)

Las plantillas de esos catálogos vienen con una trampa que las propias fuentes
admiten: **"validada" suele significar "probada en un caso", no lista para
producción.** Se rompen con datos reales (manejo de errores, ruteo, escala) y
**nadie las revisa.**

Ese hueco es exactamente lo que llena nuestro **Verifier**: el spike ya probó que
podemos **verificar la correctitud de cada build** (3/3 a ciegas, con
auto-corrección). Ellos venden tubería frágil que tú mantienes; nosotros
entregamos un **resultado comprobado**.

## Qué NO hacer

- **No competir por amplitud de integraciones.** Pelear contra 8,000 apps y
  comunidades de 30k es suicidio, y es un cliente que no es el nuestro.
- **No volvernos un "Zapier más barato".** Es el posicionamiento equivocado; nos
  mete a un océano rojo y confunde a quién le vendemos.

## La frontera (Fase 3)

Algunas cosas de integración (jalar de otra app, correr en horario) son **Fase 3**
del roadmap. Pero incluso ahí **no nos convertimos en Zapier**: la propuesta sigue
siendo *"la IA construye y verifica la automatización específica que describes"*,
no *"cablea tú los nodos"*.

## En una línea (para el pitch)

> **Zapier te da los tubos. Nosotros entregamos el agua.**

Zapier automatiza el flujo entre las apps que ya usas. Automata construye —de
cero y verificada— la automatización que ni siquiera sabías cómo pedir, para el
negocio que no tiene apps que conectar.
