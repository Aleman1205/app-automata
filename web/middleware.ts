import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Default-deny de PÁGINAS (anti forced-browsing, docs/14 §1): todo exige sesión salvo la
// allowlist pública. Las rutas /api NO las fuerza el middleware — se autentican en el
// pipeline (withEfecto → 401 JSON), que además hace CSRF/rol/step-up/cuota. clerkMiddleware
// deja disponible auth() dentro del route aunque no llame protect().
//
// ⚠️ Con este middleware, la app YA requiere llaves de Clerk (CLERK_*) para `next dev/build`.
// Es la transición de "prototipo demo" a "app real". Ver web/.env.example.

const esPublica = createRouteMatcher([
  "/", // landing
  "/contacto",
  "/precios",
  "/entrar(.*)", // login/registro de Clerk
]);
const esApi = createRouteMatcher(["/api/(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (esApi(req)) return; // la API se autentica en el pipeline (401 JSON, no redirect)
  if (!esPublica(req)) await auth.protect(); // páginas privadas: default-deny
});

export const config = {
  // Corre en todo salvo estáticos e _next; incluye /api para exponer auth() al route.
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
