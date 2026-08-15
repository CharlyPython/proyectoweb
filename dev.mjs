import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { Miniflare } from "miniflare";

// Local dev/self-check: run the built worker under miniflare and expose a tiny
// local SQLite gateway backed by Miniflare D1 (no token, no cloud). This mirrors
// production's shape: the worker calls WEBSITE_DB_URL with WEBSITE_DB_TOKEN, and
// the platform/service side executes SQL against the provisioned SQLite backend.
// The worker handles requests first; a 404 falls back to the static assets with
// SPA fallback — the same order production (Workers for Platforms) uses.
const DIST = resolve("dist");
// `surething-website dev` allocates a free port and passes it here so two sites
// can run at once; default 8787 when run directly.
const PORT = Number(process.env.PORT) || 8787;
const DEV_DB_TOKEN = "dev-site-db-token";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const cfg = JSON.parse(await readFile("website.config.json", "utf8"));
const sqlite = (cfg.bindings ?? []).filter((b) => b.type === "sqlite");
const primaryDb = sqlite[0];

const mf = new Miniflare({
  modules: true,
  scriptPath: resolve(DIST, "worker.js"),
  compatibilityDate: "2026-06-05",
  d1Databases: Object.fromEntries(sqlite.map((b) => [b.name, `dev-${b.name}`])),
  bindings: {
    WEBSITE_DB_URL: `http://localhost:${PORT}/__website-db/query`,
    WEBSITE_DB_TOKEN: DEV_DB_TOKEN,
  },
});

for (const b of sqlite) {
  if (!b.migrationsDir) continue;
  const dir = resolve(DIST, b.migrationsDir);
  const db = await mf.getD1Database(b.name);
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const raw = await readFile(resolve(dir, f), "utf8");
    for (const stmt of raw.split(";").map((s) => s.trim())) if (stmt) await db.prepare(stmt).run();
  }
}

createServer(async (req, res) => {
  if ((req.url ?? "").startsWith("/__website-db/query")) {
    if (req.headers.authorization !== `Bearer ${DEV_DB_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid token" }));
      return;
    }
    if (!primaryDb) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no database configured" }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const stmt = (await mf.getD1Database(primaryDb.name)).prepare(body.sql);
      const params = Array.isArray(body.params) ? body.params : [];
      const result = await stmt.bind(...params).all();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ rows: result.results ?? [] }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "query failed" }));
    }
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const method = req.method ?? "GET";
  const wr = await mf.dispatchFetch(`http://localhost${req.url ?? "/"}`, {
    method,
    headers: req.headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  if (wr.status !== 404) {
    res.writeHead(wr.status, Object.fromEntries(wr.headers.entries()));
    res.end(Buffer.from(await wr.arrayBuffer()));
    return;
  }
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const fp = resolve(DIST, path === "/" ? "index.html" : path.replace(/^\/+/, ""));
  if (!fp.startsWith(DIST)) return void res.writeHead(403).end();
  try {
    const buf = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(fp)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    try {
      const buf = await readFile(resolve(DIST, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(buf);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
}).listen(PORT, () => console.log(`✓ dev server on http://localhost:${PORT} (worker + local D1)`));
