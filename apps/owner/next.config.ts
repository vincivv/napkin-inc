import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.join(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: ["@napkin/ledger-core", "@napkin/schema", "@napkin/stdb-bindings"],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
};

export default nextConfig;
