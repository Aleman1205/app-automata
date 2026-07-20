# 07 — Entornos y despliegue

Detalle de [ARQUITECTURA.md](../ARQUITECTURA.md) §7.

---

## 1. Lo que hace distinto desplegar esto

En software normal, lo que despliegas es código: si compila y pasan los tests,
se comporta igual que en tu máquina.

Aquí despliegas **cuatro cosas**, y solo una de ellas tiene compilador:

| Qué | ¿Compilador? | ¿Cómo sabes que no lo rompiste? |
|---|---|---|
| Código de la app | Sí | Tests |
| **Prompts de los agentes** | **No** | **Solo la suite de regresión** |
| **El modelo y su `effort`** | **No** | **Solo la suite de regresión** |
| Imagen base del Runner | Parcial | Regresión sobre artefactos existentes |

Cambiar una frase del prompt del Builder puede degradar la tasa de éxito un 15%
sin que nada falle, sin excepción, sin alerta. **Un cambio de prompt es un
despliegue de producción de pleno derecho** y merece el mismo respeto: pasa por
Git, por revisión y por la suite de evaluación.

Y hay algo que no se puede deshacer: **una automatización ya entregada no se
revierte.** Si desplegaste un prompt malo el martes, los builds del martes ya
están en los portafolios de tus clientes. El rollback arregla los builds futuros,
no los pasados. Por eso la puerta es la suite de evals, no el rollback.

---

## 2. Los tres entornos

| | Local | Staging | Producción |
|---|---|---|---|
| Frontend | `next dev` | Preview de Vercel | Vercel |
| Base de datos | Postgres en Docker | Neon (rama) | Neon |
| Blobs | MinIO o carpeta local | Bucket staging | Bucket prod |
| Jobs | Inngest dev server | Inngest staging | Inngest prod |
| Entorno CMA | `env_dev` | `env_staging` | `env_prod` |
| Modelo | Sonnet 5 | Opus 4.8 | Opus 4.8 |
| Runner | Docker local | Igual que prod | Fly / Cloud Run |

Dos decisiones dentro de esa tabla:

**Sonnet 5 en local.** Mientras iteras sobre la UI y el pipeline lanzas decenas
de builds. Con Opus son $3 cada uno; con Sonnet, céntimos. Lo que **no** puedes
hacer es sacar conclusiones de calidad desde local — para eso está staging con
el modelo real.

**Staging usa el Runner de producción**, no Docker local. La puerta de calidad
valida artefactos ejecutándolos, y si el entorno de validación no es el de
ejecución, validas una cosa y entregas otra.

Bases de datos y buckets **completamente separados**. Un script de limpieza mal
apuntado a producción borra archivos de clientes reales, y no hay deshacer.

---

## 3. Los agentes de CMA son infraestructura, no configuración

El agente de CMA vive en los servidores de Anthropic y tiene su propio
versionado. Es un recurso de infraestructura y se trata como tal: **definido en
YAML, en tu repositorio, aplicado desde CI.**

```
agentes/
  builder.agent.yaml       modelo, system prompt, tools
  planner.agent.yaml
  intake.agent.yaml
  entornos/
    dev.environment.yaml
    prod.environment.yaml
```

```bash
# CI, al desplegar
ant beta:agents update --agent-id "$BUILDER_AGENT_ID" --version "$V" \
  < agentes/builder.agent.yaml
```

Lo que esto te evita: que el prompt que corre en producción sea uno que alguien
editó a mano en la consola hace tres semanas y nadie recuerda. Si el prompt no
está en Git, no sabes qué está corriendo.

**Guarda el `agent_id` y su versión en tu configuración.** Cada build registra
con qué versión se hizo — es la única forma de correlacionar "los builds
empeoraron" con "cambiamos el prompt el martes".

---

## 4. El pipeline de despliegue

```
push a main
  ├─ lint + tests unitarios                      ~1 min
  ├─ migraciones de base                         ~30 s
  ├─ desplegar app a staging
  ├─ ¿cambió agentes/ ?
  │    └─ aplicar YAML a CMA staging
  │       └─ SUITE DE EVALS (20 casos × 3 corridas)   ~20 min, ~$50
  │            ├─ tasa de éxito < línea base − 5%  → BLOQUEAR
  │            ├─ algún caso pasó de ok a fallo    → BLOQUEAR
  │            └─ costo medio > línea base + 30%   → avisar, no bloquear
  ├─ humo en staging: 1 build real de punta a punta
  └─ desplegar a producción
```

**La suite de evals solo corre si cambió `agentes/`.** Cuesta ~$50 y 20 minutos;
no la pagas en cada cambio de CSS.

**Bloquea por caso, no solo por promedio.** Un cambio que sube la media al 85%
pero rompe el caso que tu mejor cliente usa a diario es un mal cambio. La media
esconde exactamente lo que te va a costar el cliente.

**El costo avisa pero no bloquea.** A veces un prompt mejor es legítimamente más
caro. Que lo veas y decidas.

---

## 5. Secretos

| Secreto | Dónde vive |
|---|---|
| `ANTHROPIC_API_KEY` | Variables de Vercel / Inngest, por entorno |
| Credenciales de base | Cadena de conexión de Neon, por rama |
| Credenciales de blob | Token de R2/S3 con permiso solo a su bucket |
| Firma de webhooks | `ANTHROPIC_WEBHOOK_SIGNING_KEY` |
| Stripe | Claves separadas de test y producción |

Tres reglas: **claves distintas por entorno** (una clave de producción en local
es un incidente esperando), **nunca en el repositorio** (`.env` en `.gitignore`,
y un `.env.example` con los nombres), y **ninguna llega al contenedor de
ejecución** — el Runner no necesita ni una.

---

## 6. Rollback

Cuatro cosas se revierten de forma distinta. Tenerlo claro de antemano es la
diferencia entre 5 minutos y 5 horas:

| Qué | Cómo | Tiempo |
|---|---|---|
| Código de la app | Despliegue anterior en Vercel | 1 min |
| Prompt de agente | `ant beta:agents update` con el YAML anterior | 2 min |
| Imagen base del Runner | Volver al tag anterior | 5 min |
| Migración de base | Migración inversa — **escríbela antes** | Variable |
| **Artefacto ya entregado** | **No se revierte** | — |

La última fila otra vez: los builds malos ya están en los portafolios. Si
detectas que una tanda salió mal, lo que puedes hacer es marcarlos y ofrecer un
rebuild gratis — no deshacerlos.

**Migraciones siempre compatibles hacia atrás.** Añadir columnas, no renombrar.
Durante un despliegue conviven la versión vieja y la nueva unos minutos, y una
migración destructiva rompe la vieja mientras aún atiende peticiones.

---

## 7. Estructura del repositorio

Un solo repo. Con este tamaño de proyecto, separarlos solo añade fricción:

```
app/            Next.js — UI + API
worker/         funciones de Inngest (build, run, barridos)
agentes/        YAML de agentes CMA + prompts       ← se despliega
runner/         Dockerfile base + implementación del Runner
evals/          suite de regresión + casos
db/             migraciones
docs/           esto
spike/          la prueba desechable
```

`agentes/` merece revisión de código igual que `app/`. Es donde vive la
inteligencia del producto.

---

## 8. Lo que cuesta la infraestructura

| Servicio | Al mes |
|---|---|
| Vercel Pro | $20 |
| Neon / Supabase | $25 |
| Inngest | $0–20 |
| R2 / S3 | ~$5 |
| Sentry | $0–26 |
| Resend | $0–20 |
| Fly (runner, Fase 2) | ~$10 |
| **Fijo** | **~$70–125** |

Súmale la suite de evals: ~$50 por corrida completa. Si tocas prompts dos veces
por semana, son **$400 al mes** — más que toda la infraestructura junta.

Dos consecuencias que conviene ver ahora:

**Necesitas 4–5 clientes solo para cubrir el costo fijo.** Con 3 clientes a $30
estás en pérdidas aunque el margen por cliente sea del 90%.

**Agrupa los cambios de prompt.** Cinco cambios en una corrida de evals cuestan
lo mismo que uno. Es la diferencia entre $50 y $250 al mes.

---

## 9. Decisiones abiertas

1. **¿Suite de evals completa o reducida en cada push?** Sugerencia: 5 casos
   rápidos (~$12) en cada cambio de `agentes/`, los 20 completos antes de
   producción.
2. **¿Despliegue automático a producción o con aprobación?** Recomiendo
   aprobación manual mientras el producto sea joven — el fallo silencioso de
   calidad no lo detecta ningún test.
3. **¿Región?** Elígela ahora ([docs/04](04-multitenancy.md) §7). Cambiarla
   después con clientes dentro es una migración de datos.
