import type { NextConfig } from "next";

// The browser only ever talks to this app; API calls are proxied to the backend so its
// address can change without touching client code.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:4780";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/:path*` }];
  },
};

export default nextConfig;
