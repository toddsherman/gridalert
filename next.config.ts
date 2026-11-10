import type { NextConfig } from "next";
import { BASE_PATH } from "./lib/site.ts";

// No script-src: a nonce needs every page rendered per request, which would cost the
// cached pages this site relies on. React already escapes everything shown.
const CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Served at todd.sh/gridalert through todd.sh's proxy (lib/site.ts).
  basePath: BASE_PATH,
  experimental: {
    // Sign-ups and settings arrive through the proxy, from todd.sh rather than this host.
    serverActions: { allowedOrigins: ["www.todd.sh", "todd.sh"] },
  },
  async redirects() {
    return [
      // Alerts already sent link here.
      { source: "/blackouts", destination: "/", permanent: true },
      // Links from before the base path, including alerts and Home Screen icons, land in the same place.
      { source: "/", destination: BASE_PATH, basePath: false, permanent: false },
      { source: `/:path((?!${BASE_PATH.slice(1)}(?:/|$)).*)`, destination: `${BASE_PATH}/:path`, basePath: false, permanent: false },
    ];
  },
  async headers() {
    return [
      // The page is /gridalert with no slash, which a worker at /gridalert/sw.js can only
      // control if it's allowed a scope one level up.
      { source: "/sw.js", headers: [{ key: "Service-Worker-Allowed", value: BASE_PATH }] },
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
