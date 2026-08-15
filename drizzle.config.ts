import { defineConfig } from "drizzle-kit";

// Emits forward-only SQL migrations into migrations/db/ from src/schema.ts.
// Run `pnpm drizzle:generate` after editing the schema.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations/db",
});
