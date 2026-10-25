import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@napkin/ledger-core", "@napkin/stdb-bindings", "@napkin/schema"],
  reactStrictMode: true,
};

export default nextConfig;
