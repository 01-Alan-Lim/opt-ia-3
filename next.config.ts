import type { NextConfig } from "next";
import path from "path";

const emptyModulePath = path.resolve(__dirname, "src/empty-module.ts");

const nextConfig: NextConfig = {
  // puedes quitar reactCompiler si quieres, pero lo dejamos
  reactCompiler: true,

  // 👉 Config para Turbopack
  turbopack: {
    resolveAlias: {
      tap: "./src/empty-module.ts",
      "why-is-node-running": "./src/empty-module.ts",
      "thread-stream": "./src/empty-module.ts",
      desm: "./src/empty-module.ts",
      "fastbench": "./src/empty-module.ts",
      "pino-elasticsearch": "./src/empty-module.ts",
    },
  },

  // 👉 Config equivalente para Webpack (por si usas --webpack)
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      tap: emptyModulePath,
      "why-is-node-running": emptyModulePath,
      "thread-stream": emptyModulePath,
      desm: emptyModulePath,
      "fastbench": emptyModulePath,
      "pino-elasticsearch": emptyModulePath,
    };
    return config;
  },
};

export default nextConfig;
