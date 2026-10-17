import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // O core é TypeScript puro, então não há DOM nem jsdom para configurar.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
