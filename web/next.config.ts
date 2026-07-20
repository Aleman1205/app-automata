import type { NextConfig } from "next";

// Next 16: `next build` ya no corre ESLint (la opción eslint.* fue eliminada).
// TypeScript sí bloquea el build — intencional.
const nextConfig: NextConfig = {};

export default nextConfig;
