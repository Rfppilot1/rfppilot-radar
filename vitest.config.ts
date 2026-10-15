import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["radar-src"] },
  ssr: { resolve: { conditions: ["radar-src"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", include: ["packages/*/src/**", "apps/*/src/**"] },
  },
});
