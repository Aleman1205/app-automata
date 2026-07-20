# 04 — Multitenancy y datos del cliente

Detalle de [ARQUITECTURA.md](../ARQUITECTURA.md) §5.

---

## 1. Lo que estás guardando

Antes de la técnica, mira el inventario. Tus clientes suben **facturas, nóminas,
listas de clientes, ventas, contratos**. Es de lo más sensible que maneja una
empresa pequeña.

Y hay una parte que se pasa por alto: **los datos del cliente no viven solo en
la tabla de ejecuciones.** Están en cuatro sitios más:

| Dónde | Qué contiene | Se olvida |
|---|---|---|
| Entradas y salidas de ejecuciones | Los archivos, tal cual | No |
| **El ejemplo dentro del artefacto** | Un archivo real del cliente | **Sí** |
| **Trazas de build en CMA** | El agente leyó e imprimió sus datos | **Sí** |
| **El spec y la entrevista** | Cómo funciona su negocio por dentro | A veces |
| Logs de ejecución (stdout) | Fragmentos de filas, mensajes de error | **Sí** |

Las dos marcadas en negrita son las que rompen un "borra todos mis datos" mal
implementado. Si un cliente pide el borrado y solo limpias `runs`, **le mentiste**
— su factura sigue dentro del artefacto y en la traza del build.

Decide desde el día uno qué haces con cada fila de esa tabla. Es más fácil
diseñarlo ahora que reconstruirlo con clientes dentro.

---

## 2. Las tres capas de aislamiento

### Datos

Toda tabla lleva `org_id`. Toda consulta lo filtra. Y como filtrar a mano falla
tarde o temprano, **actívalo en la base de datos**, no solo en el código:

```sql
alter table automations enable row level security;

create policy aislamiento_org on automations
  using (org_id = current_setting('app.org_id')::uuid);
```

Con Postgres (Supabase o Neon), fijas `app.org_id` al inicio de cada petición y
la base rechaza cualquier fila de otra organización — aunque la query esté mal
escrita. **Es la diferencia entre un bug y una filtración entre clientes.**

Un bug de este tipo no se explica a un cliente. Cuesta la empresa.

### Archivos

Prefijo por organización, sin excepción:

```
s3://bucket/{org_id}/artefactos/{automation_id}/{version}/...
s3://bucket/{org_id}/runs/{run_id}/entrada/...
s3://bucket/{org_id}/runs/{run_id}/salida/...
```

Nunca un bucket público. Nunca una URL adivinable. Descargas siempre con **URL
firmada de 5 minutos**, generada tras comprobar que quien pide pertenece a esa
organización.

Poner el `org_id` como primer segmento no es estético: te deja aplicar políticas
de ciclo de vida y borrar todo lo de un cliente con una sola operación.

### Ejecución

Un contenedor por ejecución, destruido siempre, sin red. Ya está en
[docs/02-runtime](02-runtime.md) §6. Dos clientes jamás comparten proceso.

---

## 3. Organizaciones, usuarios y roles

**Las automatizaciones pertenecen a la organización, no al usuario.** Si son del
usuario, el día que esa persona deja la empresa el cliente pierde su trabajo — y
te culpa a ti, con razón.

```
organizations   id, nombre, plan, cuota_mensual, usadas_este_mes, creada_en
users           id, email, nombre
memberships     user_id, org_id, rol            ← un usuario en varias orgs
```

Tres roles bastan. Más es burocracia que nadie usa:

| Rol | Puede |
|---|---|
| `owner` | Todo, incluido facturación y borrar la organización |
| `member` | Crear y ejecutar automatizaciones |
| `viewer` | Solo ejecutar las que ya existen |

`viewer` es más útil de lo que parece: es el rol del empleado que corre el
proceso cada mes pero no debe crear ni modificar nada.

---

## 4. Retención y borrado

Propuesta de política. Ajústala, pero **ten una y escríbela en la web**:

| Dato | Retención | Por qué |
|---|---|---|
| Entradas de ejecuciones | **7 días** | Solo hacen falta para reintentar y depurar |
| Salidas de ejecuciones | **30 días** | El cliente tiene que poder volver a descargar |
| Ejemplo dentro del artefacto | Mientras viva la automatización | Es la prueba de regresión — sin él no puedes validar |
| Trazas de build | **90 días** | Soporte y depuración |
| Spec y entrevista | Mientras viva la automatización | Necesarios para los ajustes |
| Logs de ejecución | 30 días | Soporte |

La fila del ejemplo es la incómoda: **es un archivo real del cliente que
conservas indefinidamente.** Dos maneras honestas de resolverlo:

1. **Decirlo claramente**: "guardamos tu archivo de ejemplo mientras la
   automatización exista, porque es lo que nos permite comprobar que sigue
   funcionando". La mayoría lo entiende.
2. **Anonimizarlo**: durante el build, el agente genera un archivo sintético con
   la misma estructura y lo usa como ejemplo permanente. Más limpio, más
   trabajo, y a veces el dato sintético no reproduce el caso raro.

Recomiendo la **1** en el MVP y ofrecer la **2** como opción para clientes
sensibles.

### Borrado real

Cuando un cliente pide "borra todo lo mío", esto es lo que tiene que pasar de
verdad:

```
1. runs: entradas, salidas y logs        → borrado en blob
2. artefactos: incluido el ejemplo       → borrado en blob
3. specs, entrevistas, transcripciones   → borrado en base
4. sesiones de CMA                       → sessions.delete() en Anthropic
5. filas de la base                      → borrado (no soft delete)
6. copias de seguridad                   → caducan solas; dilo en la política
```

**El paso 4 se olvida siempre.** Esos datos están en la infraestructura de
Anthropic, no en la tuya, y no desaparecen porque borres tu base.

Escribe este borrado como una función única y pruébala. Si vive repartido en
seis sitios del código, tarde o temprano queda incompleto.

---

## 5. Registro de auditoría

Una tabla, append-only:

```
audit_log: id, org_id, actor_user_id, accion, recurso, metadata, ip, creado_en
```

Registra: inicio de sesión, crear/borrar automatización, ejecutar, descargar
salida, invitar/expulsar usuario, cambiar plan, pedir borrado.

Sirve para tres cosas, y las tres llegan antes de lo que crees: contestar "¿quién
descargó ese archivo?", investigar un incidente, y cerrar la venta a la primera
empresa que te pregunte si tienes trazabilidad.

---

## 6. Cómo podría filtrarse algo

Los cinco caminos reales, en orden de probabilidad:

| Riesgo | Defensa |
|---|---|
| Query sin filtro de `org_id` | RLS en la base — no depende de que el código esté bien |
| URL de descarga adivinable | URLs firmadas, caducidad corta, comprobación de pertenencia |
| Contenedor reutilizado entre clientes | Destrucción siempre, sin excepciones |
| **El artefacto de un cliente se asigna a otro** | Validar `org_id` del artefacto contra el de la ejecución, en el Runner |
| Código generado que exfiltra datos | Sin red en el contenedor |

La cuarta es específica de tu producto y no aparece en las listas genéricas: un
error al resolver qué artefacto ejecutar puede correr el código —y el ejemplo—
de un cliente dentro de la sesión de otro. **Comprueba la pertenencia dentro del
Runner**, no solo en la capa de API.

---

## 7. Decisiones abiertas

1. **¿Qué pasa al cancelar la suscripción?** Recomiendo: 30 días de solo
   lectura para descargar todo, luego borrado. Quitar el acceso el mismo día
   genera reseñas malas y disputas de cobro.
2. **¿Región de datos?** Si vas a vender en México o la UE, alguien preguntará
   dónde viven los datos. Elegir región desde el principio es gratis; migrarla
   después no.
3. **¿Anonimización del ejemplo desde el MVP?** Recomiendo no, pero decláralo
   con total claridad en la política de privacidad.
