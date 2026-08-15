import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

// Runs after `vite build` (which emits the static client into dist/). This
// bundles the Hono worker to dist/worker.js and copies the SQL migrations into
// the bundle so the platform can apply them to D1 at publish time. Everything
// the platform needs — assets, worker module, migrations — ends up under dist/.
await build({
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  conditions: ["worker", "browser"],
  keepNames: true,
});

await mkdir("dist/migrations/db", { recursive: true });
await cp("migrations/db", "dist/migrations/db", { recursive: true });

console.log("✓ built dist/worker.js and bundled migrations");
