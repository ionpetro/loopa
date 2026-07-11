import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Production Clerk keys only accept loopa.sh origins — map local.loopa.sh in
  // /etc/hosts and run `npm run dev:local` (HTTPS on :443).
  allowedDevOrigins: ["local.loopa.sh"],
  // Server-only packages that must not be bundled by webpack/turbopack:
  // they spawn processes (@cursor/sdk) or open raw sockets (playwright-core).
  serverExternalPackages: ["@cursor/sdk", "@onkernel/sdk", "playwright-core"],
  webpack: (config) => {
    // Webpack's filesystem cache warns whenever a cached module string tops
    // ~100kiB ("Serializing big strings…"). Ours come from large client deps
    // (mermaid, rive, xyflow) — a cache perf hint, not a problem. Only surface
    // real errors from webpack's infrastructure logging.
    config.infrastructureLogging = { ...config.infrastructureLogging, level: "error" };
    return config;
  },
};

export default nextConfig;
