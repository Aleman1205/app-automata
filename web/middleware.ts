import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { DEV } from "@/lib/automata/dev";

// Default-deny de PÁGINAS (anti forced-browsing, docs/14 §1): todo exige sesión salvo la
// allowlist pública. Las rutas /api NO las fuerza el middleware — se autentican en el
// pipeline (withEfecto → 401 JSON), que además hace CSRF/rol/step-up/cuota. clerkMiddleware
// deja disponible auth() dentro del route aunque no llame protect().
//
// ⚠️ Con este middleware, la app YA requiere llaves de Clerk (CLERK_*) para `next dev/build`,
// SALVO en modo DEV (AUTOMATA_DEV_AUTH=1, no-producción): ahí el middleware es passthrough y
// la sesión la stubbea el wiring. clerkMiddleware ni se construye → `next dev` arranca sin
// llaves. Es la transición de "prototipo demo" a "app real". Ver web/.env.example.

const esPublica = createRouteMatcher([
  "/", // landing
  "/contacto",
  "/precios",
  "/entrar(.*)",       // login de Clerk (y sus sub-rutas: sso-callback, etc.)
  "/registrarse(.*)", // ALTA de cuenta. Sin esto el registro caia en el default-deny y los CTA de
                      // venta ("Empezar", "Crear mi automatizacion") llevaban a una pared: nadie
                      // podia hacerse cliente.
]);
const esApi = createRouteMatcher(["/api/(.*)"]);

// ⚠️ Bypass SOLO-dev (doble-gated en DEV): passthrough puro. El ternario evalúa SOLO la rama
// elegida, así que en DEV clerkMiddleware NUNCA se invoca → `next dev` arranca sin llaves.
export default DEV
  ? () => NextResponse.next()
  : clerkMiddleware(async (auth, req) => {
      if (esApi(req)) return; // la API se autentica en el pipeline (401 JSON, no redirect)
      if (!esPublica(req)) await auth.protect(); // páginas privadas: default-deny
    });

export const config = {
  // Corre en todo salvo estáticos e _next; incluye /api para exponer auth() al route.
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
