# Adaptador de Next → el wrapping HTTP

El pipeline (`withEfecto`) es framework-agnóstico y está **probado end-to-end**
(`npm run verify:http`, 24/24, contra Postgres). Lo que falta para producción es
**thin**: traducir `NextRequest → Solicitud`, implementar los 3 puertos con servicios
reales, y montar las `route.ts`. Nada de la seguridad se decide aquí — solo se conecta.

> Esto **no está construido** (necesita Clerk + Neon + Upstash vivos). Es el contrato
> exacto de cómo se cablea. Difiere igual que Clerk (M2) y Stripe (M3).

## 1. Puertos (impl real)

```ts
// Sesion: Clerk verifica el JWT EN EL SERVIDOR (issuer + JWKS, no secreto compartido).
const sesion: Sesion = {
  async autenticar(s) {
    const { userId, sessionClaims } = await auth(); // @clerk/nextjs/server, dentro del request
    if (!userId) return null;
    const mfa = sessionClaims?.mfaVerifiedAt ? new Date(sessionClaims.mfaVerifiedAt) : undefined;
    return { userId, mfaVerificadoEn: mfa };
  },
};

// RateLimiter: FAIL-CLOSED (si Upstash está caído, negar — nunca 'return true').
const rate: RateLimiter = {
  async permitir(clave) {
    try { return (await ratelimit.limit(clave)).success; }
    catch { return false; } // store caído → negar
  },
};

// Deps del pool: automata_app (no-dueño) + afirmarRolSeguro al arrancar (docs/11 §6).
const pool = crearPool(process.env.DATABASE_URL!); // → rol automata_app en Neon
await afirmarRolSeguro(pool); // fatal si es superuser/bypassrls
const deps: Deps = { pool, sesion, rate };
```

## 2. `middleware.ts` (default-deny de rutas)

```ts
import { clerkMiddleware } from "@clerk/nextjs/server";
// Protege TODO salvo una allowlist explícita de rutas públicas (anti forced-browsing).
export default clerkMiddleware(); // configurar matcher para excluir / , /precios , etc.
```

## 3. `app/api/orgs/[orgId]/automatizaciones/route.ts`

```ts
import { crearAutomatizacionEP } from "automata-core/http/endpoints";
import { withEfecto } from "automata-core/http/pipeline";

const handler = withEfecto(crearAutomatizacionEP, deps);

export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params; // Next 16: params es Promise
  const r = await handler({
    metodo: "POST",
    orgId,                                   // de la RUTA, nunca del cuerpo
    sesionToken: req.cookies.get("__session")?.value,
    origen: req.headers.get("origin") ?? undefined,
    hostEsperado: process.env.APP_ORIGIN,    // SIEMPRE poblado (si falta, CSRF niega)
    ip: ipDelEdge(req),                      // IP saneada del edge, NO el XFF crudo
    cuerpo: await req.json().catch(() => undefined),
  });
  return Response.json(r.cuerpo, { status: r.status });
}
```

## 4. Reglas que el adaptador DEBE cumplir (o rompe la seguridad probada)

- **`orgId` de la ruta**, jamás del cuerpo (evita confused-deputy / IDOR).
- **`hostEsperado` siempre poblado** (`APP_ORIGIN`). Si falta, el pipeline niega toda
  mutación (fail-closed) — no lo dejes `undefined`.
- **`ip` saneada** por el edge (IP de conexión / último hop del proxy), no el
  `X-Forwarded-For` crudo (spoofable).
- **Errores inesperados → 500 sin stack.** `withEfecto` re-lanza lo que no es
  `NoAutorizado`/`CuotaExcedida`; el `route.ts` (o un wrapper) debe `catch` → 500
  genérico, **nunca** filtrar el mensaje/stack ni caer a 200.
- **Un solo camino con efecto.** Todo `route.ts` con efecto delega en `withEfecto`.
  Añade un test que escanee `app/api/**/route.ts` y falle si algún verbo mutante no
  pasa por el registro — la garantía anti-olvido (BFLA/BOLA) real de docs/14 §2.
- **Webhooks (CMA/Stripe) van por OTRO camino** (`core/src/webhooks/`): se saltan 0-6
  pero se autentican por **firma HMAC** sobre el **cuerpo CRUDO** — el `route.ts` del
  webhook DEBE leer `await req.text()` (nunca `req.json()` ni un body-parser antes: re-
  serializar rompe el MAC). La org se deriva por **lookup del recurso firmado** en la DB
  (session_id→org para CMA; `subscriptions.stripe_customer_id`→org para Stripe), **nunca**
  del `organization_id` del payload (docs/13 §4). Corre con la conexión de **dueño** (no
  `automata_app`), porque Stripe muta `subscriptions`, revocada al rol de app en M3.
