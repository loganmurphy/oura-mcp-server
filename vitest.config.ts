import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // The `cloudflare:workers` module is only available in the CF Workers
      // runtime. Redirect it to a minimal stub so Vitest's Node environment
      // can import code that depends on WorkerEntrypoint.
      "cloudflare:workers": path.resolve(
        __dirname,
        "src/__tests__/mocks/cloudflare-workers.ts",
      ),
    },
  },
  test: {
    environment: "node",
    server: {
      deps: {
        // Force @cloudflare/workers-oauth-provider through Vite's pipeline so
        // the cloudflare:workers alias above applies to its internal imports too.
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/utils.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "src/__tests__/mocks/**", "src/ui.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
      reporter: ["text", "lcov", "html"],
    },
  },
});
