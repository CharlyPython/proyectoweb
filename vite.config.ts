import { defineConfig } from "vite";

// Builds the static client into dist/. The Hono worker is bundled separately by
// build.mjs; `pnpm dev` builds both and serves them via miniflare (see dev.mjs)
// so the worker + local D1 run end to end for self-checks.
export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
});
