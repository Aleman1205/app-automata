# 09 — Sistema de componentes y consistencia visual

---

## 1. El principio

**El agente no escribe interfaz. Declara qué componentes quiere, y tu app los
renderiza.**

Si el agente genera HTML, CSS o React, cada automatización se ve distinta.
Aunque le des una guía de estilo en el prompt, con cien automatizaciones tendrás
cien tonos de azul, ocho tamaños de botón y tablas que no se parecen entre sí.
Los prompts orientan; no garantizan.

Si en cambio el agente solo puede elegir de un catálogo cerrado:

```jsonc
{ "tipo": "tabla", "fuente": "resultado", "columnas": ["proveedor", "total"] }
```

…la consistencia deja de ser un objetivo y pasa a ser **estructuralmente
imposible de romper**. El agente no puede desviarse porque no tiene con qué.

Cuatro consecuencias, todas buenas:

| | Por qué |
|---|---|
| **Consistencia garantizada** | El agente elige *qué*; tú controlas *cómo se ve* |
| **Seguridad** | Cero código generado por IA ejecutándose en el navegador de tus clientes |
| **Rediseño global gratis** | Cambias el componente `tabla` y las cien automatizaciones se actualizan |
| **Sin compilación** | Una vista es un JSON, no un bundle que hay que construir y desplegar |

La segunda merece énfasis: **si el agente generara React que corre en tu app,
estarías ejecutando código de IA dentro de la sesión autenticada de tu cliente.**
Un XSS con acceso a su sesión. La declaración JSON elimina esa clase de
vulnerabilidad por completo.

---

## 2. La vista, dentro del artefacto

El artefacto de [docs/01](01-artefacto.md) gana un archivo:

```
artefacto/
  automatizacion.py
  requirements.txt
  manifiesto.json
  vista.json          ← nuevo: cómo se presenta el resultado
  ejemplo/
  meta.json
```

```jsonc
{
  "version_vista": 1,
  "titulo": "Reporte de ventas por vendedor",
  "bloques": [
    {
      "tipo": "fila_metricas",
      "metricas": [
        { "etiqueta": "Total vendido", "valor": "@resultado.total",   "formato": "moneda" },
        { "etiqueta": "Vendedores",    "valor": "@resultado.n_vendedores" },
        { "etiqueta": "Mejor mes",     "valor": "@resultado.mejor_mes" }
      ]
    },
    {
      "tipo": "grafica",
      "variante": "barras",
      "titulo": "Ventas por vendedor",
      "fuente": "@resultado.por_vendedor",
      "eje_x": "vendedor",
      "eje_y": "total"
    },
    {
      "tipo": "tabla",
      "fuente": "@resultado.detalle",
      "columnas": [
        { "campo": "vendedor", "etiqueta": "Vendedor" },
        { "campo": "total",    "etiqueta": "Total", "formato": "moneda", "alinear": "derecha" }
      ],
      "ordenable": true,
      "buscable": true
    },
    { "tipo": "descarga", "archivo": "@salidas.reporte", "etiqueta": "Descargar Excel" }
  ]
}
```

Las referencias `@resultado.*` apuntan a un JSON que el script escribe en
`/out/resultado.json`. Ese es el contrato: **el script produce datos, la vista
los presenta.** Ninguno sabe del otro más que ese archivo.

---

## 3. El catálogo v1

Empieza pequeño. Quince componentes cubren casi todo, y cada uno que añades es
uno que hay que construir, documentar, validar y enseñarle al agente.

**Estructura**

| Componente | Para |
|---|---|
| `seccion` | Agrupar con título |
| `columnas` | Dividir en 2–3 |
| `pestanas` | Separar vistas del mismo resultado |

**Datos**

| Componente | Para | Variantes |
|---|---|---|
| `fila_metricas` | 2–4 números destacados | — |
| `tabla` | Datos tabulares | ordenable, buscable, paginada |
| `grafica` | Visualización | barras, líneas, pastel, área |
| `lista` | Elementos no tabulares | simple, con acciones |
| `texto` | Explicación o resumen | párrafo, aviso, destacado |

**Interacción**

| Componente | Para |
|---|---|
| `formulario` | Entradas — se genera solo desde `manifiesto.json` |
| `boton` | Acción: ejecutar, descargar, ir a |
| `filtro` | Acotar los datos mostrados |
| `descarga` | Bajar un archivo de salida |

**Estados**

| Componente | Para |
|---|---|
| `vacio` | Sin datos todavía |
| `cargando` | Ejecutándose |
| `error` | Falló, con mensaje humano |

Fíjate en lo que **no** está: nada de color, tipografía, espaciado, ancho ni
posición. **El agente no toma decisiones estéticas. Ni una.** Esa es la
diferencia entre un producto consistente y cien páginas distintas.

---

## 4. Cómo se garantiza que el agente no se salga

Tres capas, y las tres hacen falta:

**1. El prompt.** Se le entrega el catálogo con ejemplos de cada componente.
Orienta, pero no garantiza — nunca confíes solo en esto.

**2. Salida estructurada.** La vista se genera con un esquema JSON estricto
donde `tipo` es un enum cerrado. El modelo no puede emitir un componente que no
exista: la restricción es del formato, no del criterio del agente.

**3. Validación en la puerta de calidad.** Antes de publicar:

```
· ¿Valida contra el esquema?
· ¿Todos los `tipo` están en el catálogo?
· ¿Todas las referencias @resultado.* existen en el resultado.json del ejemplo?
· ¿Los formatos declarados coinciden con los tipos reales de los datos?
```

Si algo falla → `failed`, rebuild. No se publica una vista rota.

La capa 3 es la que atrapa el caso real: el agente inventa
`@resultado.promedio_mensual`, el script nunca lo calcula, y el cliente ve un
hueco. Validar las referencias contra el ejemplo lo detecta antes de entregarlo.

---

## 5. Plantillas de dominio

Aquí encaja lo que planteaste: no plantillas de proyectos completos, sino
**composiciones típicas** que el agente elige y adapta.

```
plantillas/
  reporte-resumen.json      métricas + gráfica + tabla + descarga
  panel-seguimiento.json    filtros + métricas + tabla ordenable
  lista-revision.json       tabla con acciones + estado vacío
  comparativo.json          dos gráficas lado a lado + tabla
```

Una plantilla es una **vista.json con huecos**. El agente elige la que encaja y
rellena campos, títulos y formatos según el spec.

Por qué esto es mejor que dejarle componer libre:

- **Un panel de seguimiento se ve igual para todos tus clientes.** Reconocible.
- El agente resuelve un problema mucho más fácil: elegir y rellenar, en vez de
  diseñar desde cero. **Menos decisiones, menos errores, builds más baratos.**
- Cada plantilla se prueba una vez y funciona en todas partes.

Empieza con 4. Cuando veas que el 30% de las automatizaciones componen algo
parecido y no encaja en ninguna, esa es tu quinta plantilla.

---

## 6. Sobre el CRM: esto es otro producto

Mencionaste un CRM, y ahí hay una bifurcación que conviene ver antes de
construir nada.

Todo lo diseñado hasta ahora es **sin estado**: entra un archivo, corre un
script, sale un resultado. Se ejecuta, se muestra, se acabó.

Un CRM **no** es eso. Necesita:

| | Automatización (lo diseñado) | CRM / app interna |
|---|---|---|
| Datos | Efímeros, por ejecución | **Persistentes, propios** |
| Operaciones | Ejecutar | **Crear, leer, editar, borrar** |
| Base de datos | No tiene | **Una por cliente, con su esquema** |
| Concurrencia | Una ejecución | **Varios usuarios a la vez** |
| Permisos | Del plan | **Por registro y por campo** |
| Migraciones | No aplican | **Cuando cambia el esquema** |

Eso no es una automatización con vista bonita. Es un **generador de
aplicaciones**, y multiplica el alcance del producto por varias veces.

**Mi recomendación: haz primero las vistas, no las apps.**

**Fase A — Automatizaciones con vista** (encaja en lo ya diseñado)
Paneles, reportes, comparativos sobre el resultado de una ejecución. Sin datos
propios. Es la extensión natural y aprovecha todo lo construido.

**Fase B — Aplicaciones con datos** (proyecto aparte)
CRM, inventarios, seguimiento. Requiere almacenamiento por cliente, CRUD,
esquemas versionados y permisos. Es un producto distinto, con su propia
arquitectura.

Lo bueno: **el sistema de componentes de este documento sirve para las dos.** No
es trabajo tirado. Construyes el catálogo ahora para las vistas, y el día que
hagas la Fase B ya tienes el vocabulario visual resuelto.

La razón para no mezclarlas todavía es que la Fase B duplica la superficie del
producto antes de que hayas validado la Fase A. Si las automatizaciones sin
estado no convencen a los clientes, un CRM generado tampoco lo hará.

---

## 7. Decisiones abiertas

1. **¿Vistas desde el MVP o después?** Recomiendo un `vista.json` mínimo desde
   el principio —métricas + tabla + descarga— porque «descarga un Excel» se
   siente pobre al lado de «mira tu resultado y descárgalo si quieres».
2. **¿El cliente puede reordenar la vista?** Recomiendo que no al principio.
   Cada opción de personalización es una decisión que le pasas al cliente, y él
   quiere su resultado, no un editor.
3. **¿Cuándo Fase B?** Sugerencia: cuando tengas 20 clientes de pago pidiéndolo
   explícitamente. Antes es construir sobre una hipótesis.
