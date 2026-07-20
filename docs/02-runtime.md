# 02 — El runtime de ejecución (Run)

Detalle de [ARQUITECTURA.md](../ARQUITECTURA.md) §2.

---

## 1. La regla que lo gobierna todo

**El Run no usa modelos de lenguaje. Ni uno.**

Toma el artefacto, lo ejecuta, devuelve el resultado. Es ejecución de código
normal — determinista, rápida y baratísima. Toda la inteligencia se pagó una
vez, durante el Build.

Si algún día te encuentras metiendo una llamada a un modelo en el Run "solo para
este caso", párate: acabas de convertir cada ejecución en un gasto variable y de
romper el determinismo que le prometiste al cliente.

---

## 2. La aritmética del margen

Un cliente con un proceso diario ejecuta unas **500 veces al mes**. Ese número
decide tu arquitectura:

| Runtime | Costo/ejecución | 500 ejecuciones/mes |
|---|---|---|
| Sesión de CMA | ~$0.30 | **$150** |
| Contenedor propio efímero | ~$0.001 | **$0.50** |
| Sandbox como servicio (E2B, Modal) | ~$0.01 | **$5** |

Con un plan de $49/mes, la primera fila te hace perder $100 al mes con **un solo
cliente activo**. Y cuanto más lo usa, más pierdes — que es exactamente el
incentivo al revés del que quieres.

**Aun así, recomiendo empezar con CMA.** Con 5 clientes de prueba y pocas
ejecuciones, son $20 al mes contra dos semanas construyendo infraestructura. El
error no es usar CMA en el MVP: es no tener planeada la salida.

**La señal para migrar** — la que llegue primero:
- El costo de ejecuciones pasa el 20% del ingreso.
- Un cliente supera las 100 ejecuciones/mes.
- Alguien se queja de que tarda.

---

## 3. La interfaz `Runner`

Esta interfaz es lo que hace que la migración sea un cambio de implementación y
no una reescritura. **Escríbela desde el primer día**, aunque solo exista la
versión de CMA detrás.

```ts
interface Runner {
  ejecutar(params: {
    artefacto: ArtefactoRef;              // org, automation, version
    entradas:  { archivos: File[]; params: Record<string, unknown> };
    limites:   { timeoutSeg: number; memoriaMb: number; red: boolean };
  }): Promise<{
    estado:   "ok" | "entrada_invalida" | "error" | "timeout" | "sin_memoria";
    salidas:  File[];
    logs:     string;      // stdout — nunca se le muestra al cliente
    codigo:   number;
    duracion: number;
    costo:    number;
  }>;
}
```

Dos implementaciones: `RunnerCMA` (MVP) y `RunnerContenedor` (Fase 2). Nada del
resto del sistema sabe cuál está activa. Una variable de entorno decide.

Esto también te deja migrar **de forma gradual**: por organización o por
porcentaje de tráfico. Mandas el 5% de las ejecuciones al runner nuevo, comparas
resultados con el viejo, y subes cuando coinciden.

---

## 4. Anatomía de una ejecución

```
 1. Validar entradas contra el manifiesto      ← backend, milisegundos, sin contenedor
 2. Materializar entradas en almacenamiento temporal
 3. Arrancar contenedor desde imagen base + capa de dependencias
 4. Montar  /in (solo lectura)  ·  /out (escritura)  ·  /tmp
 5. python automatizacion.py --input /in --output /out --params params.json
 6. Vigilar: timeout, memoria, tamaño de salida
 7. Recoger /out, stdout, código de salida
 8. Destruir el contenedor  ← siempre, pase lo que pase
 9. Subir salidas a blob, registrar el run
```

El paso 1 evita el 80% de los arranques inútiles: si falta una columna, no hace
falta encender nada.

El paso 8 va en un `finally`. Un contenedor que sobrevive a un error es un
contenedor que sigue costando dinero y sigue teniendo los datos de un cliente
dentro.

---

## 5. Diseño de la imagen

Tres capas, para que el arranque sea rápido:

```
┌─ Capa 3: artefacto           ~50 KB     (cambia en cada versión)
├─ Capa 2: dependencias extra  variable   (cacheada por hash de requirements.txt)
└─ Capa 1: imagen base         ~400 MB    (cambia una vez al mes)
     python:3.12-slim + pandas, openpyxl, numpy, python-dateutil,
     pypdf, Pillow, requests
```

La capa 2 es la que decide si tu Run es rápido o lento. **Cacheada por hash del
`requirements.txt`**: cien automatizaciones que usan `pandas==2.2.3` comparten
la misma capa y no pagan `pip install`. Sin caché, cada ejecución arranca con 40
segundos de instalación — inaceptable.

La mayoría de artefactos no necesitarán capa 2 en absoluto, porque la base ya
trae lo común. Ese es el objetivo al elegir qué va en la base.

**Reconstruye la base una vez al mes** con parches de seguridad, y pasa la suite
de regresión completa antes de publicarla. Una imagen base sin actualizar es
deuda de seguridad que crece sola.

---

## 6. El límite de seguridad

Estás ejecutando código que escribió una IA a partir de la descripción de un
desconocido. Trátalo como hostil, siempre.

| Control | Valor | Por qué |
|---|---|---|
| Red | **Desactivada** | Sin red no hay exfiltración de datos. Es el control más fuerte y el más barato. |
| **Aislamiento del kernel** | **gVisor (o microVM)** | Ver abajo — el control portante del cross-tenant |
| Usuario | No-root, UID fijo | Escalar privilegios se vuelve mucho más difícil |
| Raíz del sistema | Solo lectura | Solo `/out` y `/tmp` escriben |
| Memoria | 512 MB (tope duro) | Un bucle no tumba el host |
| CPU | 1 núcleo, 300 s | Idem |
| Procesos | Máx. 64 | Frena bombas de procesos |
| Tamaño de `/out` | 100 MB | Frena llenar el disco |
| Vida del contenedor | Se destruye siempre | Cero estado entre ejecuciones |

**Sobre el aislamiento del kernel — corrección del red-team
([docs/11](11-threat-model.md) §3).** El borrador ponía gVisor/Firecracker como
"para cuando el producto crezca". Es un error: **ejecutar código arbitrario del
cliente ES el producto**, así que un escape del contenedor es el único eslabón
entre un cliente malicioso y los datos de otro — no un riesgo lejano. "Sin red"
corta la exfiltración *después* de un escape, pero no el escape. Un contenedor
`runc` estándar comparte kernel con el host; una vulnerabilidad de kernel lo
atraviesa. **gVisor** (intercepta las syscalls en espacio de usuario, casi sin
costo de operación) es el mínimo razonable para el cross-tenant, y debería
estar desde el primer cliente de pago, no después. Firecracker (microVM) es más
fuerte y más caro de operar — la opción si el volumen lo justifica.

**Nunca reutilices un contenedor entre clientes.** El ahorro de arranque no
compensa ni de lejos el riesgo de que datos de un cliente aparezcan en la
ejecución de otro. Ese incidente no se explica.

Cuando lleguen las integraciones (Fase 3) y algún artefacto necesite red, no
abras la red entera: **lista blanca de dominios por artefacto**, declarada en el
manifiesto y aprobada durante el build. Y las credenciales nunca entran al
contenedor — se inyectan en la salida, fuera del sandbox.

---

## 7. Concurrencia, cola y arranque en frío

**Cola por organización, no global.** Un cliente que lanza 50 ejecuciones no
puede dejar esperando a los demás. Límite de concurrencia por org (empieza en 5)
y una cola justa entre organizaciones.

**Arranque en frío.** Con contenedores propios son 1–3 segundos. Para una
ejecución que dura 30, es aceptable. Si molesta, un pool tibio de 2–3
contenedores base ya arrancados lo baja a milisegundos — pero **no lo construyas
hasta que sea un problema medido**. Es complejidad que se paga en bugs raros.

**Idempotencia.** Cada ejecución lleva una clave; si el cliente da doble clic o
la red reintenta, no se ejecuta dos veces. Es barato de implementar y evita
cobrar y ejecutar de más.

---

## 8. Qué registrar de cada ejecución

```
runs: id, version_id, org_id, estado, codigo_salida,
      duracion_ms, memoria_pico_mb, tamaño_entrada, tamaño_salida,
      logs_ref, creado_por, creado_en
```

Tres métricas que quieres mirar cada semana:

- **Tasa de éxito por automatización.** Una que baja del 90% tiene un artefacto
  frágil: entra en la cola de rebuild.
- **Duración p95.** Si sube, los archivos de los clientes están creciendo y el
  timeout se acerca.
- **Tasa de `entrada_invalida`.** Alta significa que el manifiesto describe mal
  lo que el cliente realmente sube. Se arregla mejorando alias y ayudas, no el
  código.

**Los logs no se le enseñan al cliente jamás.** Son para tu soporte. El cliente
ve mensajes escritos para humanos, como en [01-artefacto](01-artefacto.md) §7.

---

## 9. Recomendación concreta

**MVP:** `RunnerCMA`. Cero infraestructura nueva. Aceptas el costo porque el
volumen es mínimo y ganas semanas.

**Fase 2:** `RunnerContenedor` sobre **Fly Machines** o **Cloud Run Jobs**.
Ambos arrancan un contenedor por petición, cobran por segundo y se apagan solos,
**y ambos pueden correr con gVisor** (Cloud Run lo usa por defecto en su primera
generación; Fly permite runtime endurecido) — que es justo lo que §6 exige para
el cross-tenant. Fly arranca más rápido; Cloud Run integra mejor si ya estás en
Google. Cualquiera sirve — no gastes una semana eligiendo.

**Matiz sobre el MVP con `RunnerCMA`:** el aislamiento entre sesiones lo provee
Anthropic (contenedores gestionados). Sirve para arrancar, pero verifica su
modelo de aislamiento antes de meter datos sensibles de varios clientes — si no
te da garantías cross-tenant equivalentes a gVisor, ese es otro motivo para
adelantar el runner propio ([docs/11](11-threat-model.md) §12, decisión #1).

**Lo que no debes hacer:** montar Kubernetes para esto. Es un contenedor efímero
por petición; los servicios gestionados lo resuelven y no te obligan a operar un
clúster.

---

## 10. Decisiones abiertas

1. **¿Cuánto tiempo guardas las salidas?** Sugerencia: 30 días y borrado
   automático, con opción de descargar. Guardar para siempre es coste y
   responsabilidad legal.
2. **¿Ejecuciones concurrentes por plan?** Un límite por tier es una palanca de
   monetización natural y protege la infraestructura.
3. **¿Timeout configurable por automatización?** Algunos procesos legítimamente
   tardan. Sugerencia: 300 s por defecto, hasta 900 s si el build demuestra que
   lo necesita.
