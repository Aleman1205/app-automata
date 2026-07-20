# 01 — El artefacto

Detalle de [ARQUITECTURA.md](../ARQUITECTURA.md) §1.

El artefacto es lo que el Builder entrega y lo único que el Runner ejecuta. Tres
piezas del sistema dependen de que esté bien definido:

- El **Runner** lo ejecuta sin saber nada de qué hace.
- La **UI** dibuja el formulario del cliente leyendo su manifiesto.
- La **puerta de calidad** lo valida contra su propio ejemplo antes de publicar.

---

## 1. El problema que define todo el diseño

El cliente valida la automatización con un archivo de ejemplo en enero. En marzo
la ejecuta con el archivo real del mes, que trae una columna nueva, encabezados
en mayúsculas o una fila vacía al final.

Sin defensa, el cliente ve esto:

```
Traceback (most recent call last):
  File "automatizacion.py", line 42, in <module>
    df.groupby('vendedor')
KeyError: 'vendedor'
```

Un cliente que no programa lee eso y concluye que tu producto está roto. **No
volverá a confiar en él**, aunque el problema fuera su archivo.

Todo lo que sigue existe para que en su lugar lea:

> **No pudimos ejecutar tu automatización.** El archivo que subiste no tiene la
> columna **vendedor**. Encontramos estas: `Fecha`, `Vendedora`, `Monto`.
> ¿Será `Vendedora`?

Eso es un producto. Un traceback no lo es.

---

## 2. Estructura del artefacto

```
artefactos/{org_id}/{automation_id}/{version}/
  automatizacion.py       punto de entrada
  requirements.txt        dependencias con versión exacta
  manifiesto.json         contrato con la UI y el Runner
  ejemplo/
    entrada.csv           con lo que se validó
    salida.xlsx           resultado aprobado por el Verifier
  meta.json               spec, rubric, modelo, costo, fecha, hash
```

Inmutable. Un cambio genera una versión nueva; nunca se sobrescribe. Así el
rollback es cambiar un puntero (`current_version_id`) y no restaurar un backup.

### Interfaz del script

Una sola forma, siempre la misma:

```bash
python automatizacion.py --input /in --output /out --params params.json
```

- `/in` — carpeta con los archivos que subió el cliente, con los nombres que
  declara el manifiesto.
- `/out` — carpeta vacía; todo lo que aparezca ahí se le entrega al cliente.
- `params.json` — las entradas que no son archivos (textos, números, fechas).
- **stdout** — logs. Nunca se le muestran al cliente; son para tu soporte.
- **Código de salida** — `0` bien, `2` entrada inválida, otro = error del código.

Ese `2` importa: distingue "el archivo del cliente estaba mal" de "nuestro
código falló". Un caso se resuelve con un mensaje al cliente, el otro abre un
ticket. Confundirlos hace que tu soporte no escale.

---

## 3. El manifiesto

Es el contrato. La UI dibuja el formulario leyéndolo; el Runner valida con él.

```jsonc
{
  "version_manifiesto": 1,
  "runtime": "python-3.12",

  "entradas": [
    {
      "id": "ventas",
      "tipo": "archivo",
      "etiqueta": "Archivo de ventas",
      "ayuda": "El export mensual de tu sistema, en Excel o CSV",
      "requerido": true,
      "formatos": ["csv", "xlsx"],
      "max_mb": 25,

      // Lo que hace posible el mensaje de error humano de §1
      "esquema": {
        "columnas_requeridas": [
          { "nombre": "fecha",    "tipo": "fecha",  "alias": ["Fecha", "FECHA", "fec"] },
          { "nombre": "vendedor", "tipo": "texto",  "alias": ["Vendedor", "Asesor", "Agente"] },
          { "nombre": "monto",    "tipo": "numero", "alias": ["Monto", "Importe", "Total"] }
        ],
        "columnas_opcionales": [
          { "nombre": "estado", "tipo": "texto", "alias": ["Estado", "Status"] }
        ],
        "min_filas": 1
      }
    },
    {
      "id": "mes",
      "tipo": "seleccion",
      "etiqueta": "¿Qué mes quieres reportar?",
      "requerido": true,
      "opciones": [
        { "valor": "todos",   "etiqueta": "Todos los meses del archivo" },
        { "valor": "ultimo",  "etiqueta": "Solo el mes más reciente" }
      ],
      "default": "todos"
    }
  ],

  "salidas": [
    { "id": "reporte", "tipo": "archivo", "formato": "xlsx",
      "etiqueta": "Reporte de ventas por vendedor",
      "nombre_archivo": "reporte-ventas-{fecha}.xlsx" }
  ],

  "limites": { "timeout_seg": 300, "memoria_mb": 512, "requiere_red": false }
}
```

### Tipos de entrada y cómo se dibujan

| `tipo` | Widget en la UI | Llega al script como |
|---|---|---|
| `archivo` | Zona de arrastrar y soltar | Archivo en `/in/{id}.{ext}` |
| `texto` | Campo de texto | `params.json → {id}` |
| `numero` | Campo numérico | `params.json → {id}` |
| `fecha` | Selector de fecha | ISO-8601 en `params.json` |
| `seleccion` | Desplegable o radios | `params.json → {id}` |
| `booleano` | Interruptor | `params.json → {id}` |

Seis tipos cubren prácticamente todo. **Resiste la tentación de añadir más**:
cada tipo nuevo es un widget que construir, validar y mantener, y el Builder
tiene que aprender a declararlo correctamente.

### El campo `alias` es el que salva las ejecuciones

El Runner intenta emparejar las columnas del archivo real con las requeridas,
en este orden: nombre exacto → alias declarado → normalizado (minúsculas, sin
acentos ni espacios) → parecido alto (distancia de edición).

Cuando encuentra por parecido, **no adivina en silencio**: ejecuta y avisa.

> Usamos la columna **Vendedora** como *vendedor*. Si no es correcto, corrígelo
> en el archivo y vuelve a intentar.

Cuando no encuentra nada, se detiene con el mensaje de §1.

**Instrucción para el Builder:** al generar el manifiesto, incluye en `alias`
las variantes plausibles del nombre de cada columna. Es barato para el agente y
es la diferencia entre una automatización frágil y una robusta.

---

## 4. Dependencias

**Imagen base con lo común ya instalado**: `pandas`, `openpyxl`, `numpy`,
`python-dateutil`, `pypdf`, `Pillow`, `requests`. Cubre la mayoría de procesos
de oficina y evita un `pip install` en cada ejecución.

Si el artefacto pide algo más, `requirements.txt` con **versión exacta**:

```
pandas==2.2.3      ✓
pandas>=2.0        ✗  cambia solo, rompe en marzo lo que funcionaba en enero
pandas             ✗  peor todavía
```

**Lista blanca de paquetes, servida por un mirror privado.** El Builder solo
puede pedir de un catálogo aprobado. Un agente que instala paquetes arbitrarios
desde PyPI es un vector de ataque por confusión de nombres — un paquete con
nombre parecido a uno real, subido por cualquiera — y peor: el `setup.py` de un
paquete malicioso ejecuta código con red **durante el build**. Por eso la lista
blanca no se aplica solo revisando el `requirements.txt` final: **el sandbox de
build resuelve paquetes contra un mirror privado que solo sirve lo aprobado,
con DNS fijado** ([docs/11](11-threat-model.md) §5). Si un build necesita algo
fuera de la lista, se marca para revisión tuya y se añade a mano.

**Capa de dependencias cacheada por hash de `requirements.txt`.** Cien
automatizaciones que usan `pandas==2.2.3` comparten la misma capa. Sin esto
pagas 40 segundos de `pip install` en cada ejecución. **Como se comparte entre
tenants, es inmutable y direccionada por contenido**: se construye solo desde
paquetes pinneados de la lista blanca, por un builder de confianza, y ningún
sandbox de build o run puede escribirla ([docs/11](11-threat-model.md) §5).

---

## 5. Validación antes de ejecutar

El Runner valida **antes** de arrancar el contenedor. Un error de entrada no
debe costar ni un segundo de cómputo.

```
1. ¿Están todas las entradas requeridas?          → falta "archivo de ventas"
2. ¿El formato coincide?                          → subiste .docx, se espera .csv/.xlsx
3. ¿Tamaño dentro del límite?                     → 40 MB, el máximo es 25
4. ¿El archivo abre?                              → parece dañado
5. ¿Están las columnas requeridas (con alias)?    → falta "vendedor"; ¿será "Vendedora"?
6. ¿Los tipos cuadran?                            → "monto" trae texto en 12 filas
   ─────────────────────────────────────────
   Recién aquí: arrancar contenedor
```

Los pasos 1–6 corren en tu backend, en milisegundos. **Cada mensaje de error
nombra el problema y propone la acción.** Nunca "validación fallida".

**Seguridad del parseo (paso 4).** Abrir un xlsx para validarlo es parsear un
ZIP/XML completo — un archivo malicioso (decompression-bomb) puede reventar la
memoria del proceso que lo abre. Este parseo **no corre en el proceso web
compartido**: va en un **worker aislado con RAM y CPU acotadas**, en modo
`read_only`, con límite de ratio de descompresión, tope de celdas/filas y
timeout. Si el archivo es una bomba, muere el worker, no la API
([docs/11](11-threat-model.md) §4). El contenido del archivo, además, es dato
hostil para el Builder (una celda puede llevar una inyección) — tratamiento en
docs/11 §4–§5.

---

## 6. Ciclo de vida y versionado

```
v1  ready      ← la que corre hoy (current_version_id)
v2  building   ← el cliente pidió un ajuste
```

Mientras v2 se construye, **v1 sigue funcionando**. Si v2 pasa la puerta de
calidad, el puntero se mueve; si falla, no pasa nada y el cliente ni se entera.

**Regla: nunca dejes al cliente sin automatización funcionando.** Un ajuste que
rompe lo que ya servía es peor que no haber ofrecido el ajuste.

Rollback = mover `current_version_id` a la versión anterior. Instantáneo,
porque los artefactos son inmutables.

### La puerta de calidad, en detalle

Antes de que una versión llegue a `ready`, **tu código** (no el agente):

1. Comprueba que el artefacto trae las cuatro piezas obligatorias.
2. Valida el manifiesto contra su esquema JSON.
3. Verifica que las dependencias están en la lista blanca y llevan versión fija.
4. Ejecuta el artefacto en el Runner real contra `ejemplo/entrada.csv`.
5. Compara la salida con `ejemplo/salida.xlsx`.
6. Si es un ajuste (v2), corre también los ejemplos de las versiones anteriores.

Cualquier fallo → `failed`, reintento gratis, y la traza queda guardada.

El paso 4 es el que no puedes saltarte: **el agente valida dentro del sandbox de
CMA, que no es tu entorno de ejecución.** Que funcione allí no garantiza que
funcione en tu Runner. La puerta de calidad es lo único que cubre esa brecha.

---

## 7. Cuando falla en producción

| Qué pasó | Código | Qué ve el cliente | Qué haces |
|---|---|---|---|
| Falta una entrada | — | "Falta el archivo de ventas" | Nada, se corrige solo |
| Columna ausente | — | "Falta *vendedor*; ¿será *Vendedora*?" | Nada |
| El script rechaza la entrada | `2` | El mensaje que imprimió el script | Nada |
| Excepción del código | `1` | "Algo salió mal, lo estamos revisando" | **Alerta.** Bug del artefacto. |
| Timeout | `124` | "Tardó demasiado. ¿El archivo es más grande de lo normal?" | Revisar si escala |
| Sin memoria | `137` | Igual que timeout | Revisar |

**El caso `1` es el importante.** Significa que el artefacto pasó la puerta de
calidad pero se rompe con datos reales — casi siempre porque los datos reales
son más sucios que el ejemplo. La respuesta correcta: guardar la entrada que lo
rompió (con permiso del cliente), añadirla como caso de prueba, y relanzar el
build con ese archivo incluido. **Cada fallo en producción hace la
automatización más robusta**, si tienes el circuito montado.

---

## 8. Decisiones abiertas

1. **¿Python solamente, o también JavaScript?** Recomiendo **solo Python** al
   principio: mejor para datos, documentos y hojas de cálculo, que es donde
   estarán el 90% de los procesos. Un solo runtime es la mitad de infraestructura.
2. **¿Se guarda la entrada que provocó un fallo?** Muy valioso para arreglar,
   pero son datos del cliente. Sugerencia: pedir permiso explícito, guardar 30
   días, borrado automático.
3. **¿Puede una automatización llamar a internet?** Hoy `requiere_red: false`
   siempre. Cuando lleguen las integraciones (Fase 3) esto cambia y se vuelve la
   decisión de seguridad más delicada del producto.
