import { drizzle } from "drizzle-orm/sqlite-proxy";
import { type Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { and, eq, sql as rawSql } from "drizzle-orm";
import {
  users,
  sessions,
  providerAccounts,
  refreshRequests,
  transactions,
  bridgeTokens,
} from "./schema";

// One module worker = the whole site: Hono serves the JSON API, and the static
// client (built by Vite) is served by the platform's assets layer with an SPA
// fallback. The worker talks to the platform SQLite gateway, which wraps the
// provisioned database; no Cloudflare D1 credential or native binding is
// exposed to user code.
type Env = {
  WEBSITE_DB_URL: string;
  WEBSITE_DB_TOKEN: string;
};

const app = new Hono<{ Bindings: Env }>();

const PROVIDERS = ["tradeify", "bulenox"] as const;
type Provider = (typeof PROVIDERS)[number];

// Public RSA-OAEP key for the credential-encryption bridge (see
// scripts/gen_bridge_keys.py in the owning agent's private workspace — the
// matching PRIVATE key never leaves that workspace and is never published
// here). This is a public key, not a secret: it can only encrypt, never
// decrypt, so embedding it in site source carries no exposure.
const BRIDGE_PUBLIC_JWK: JsonWebKey = {
  kty: "RSA",
  n: "oFH8DMhIR82ELoYSG6BTtW7NiT4L3rURl6o6HG7xQWiizl1W8mbcBej31h9SRC0wxxbI74rCnzNKBivkB1iGJ9zpZfw1AMTZUjD_KuoBO20k482eLsj2b5XIuj3m1RyRGnHNvtFSQNTFbxiPV6TUioKS6govHM3y0iE5vKEL_G5bdhi9Hvjc7NyXUn2_fDQ5lwwWvD98l3YKzy5zoo1hiwO80Ny7JCfkWMPLrduQDVzOWKe5mcBMcF9ungtPhbhsU61Rs564xnp0cEvAQbRPGNEKmjyx4W0M840tdn7TZ8aXTfKnJADuAlSQ40W7AzKdqb8jdzATJ_fofPa6X0Qo0Q",
  e: "AQAB",
  alg: "RSA-OAEP-256",
  ext: true,
};

function callerFunctionName(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(1)) {
    const match = line.match(/\bat (?:async )?([^\s(]+)/);
    const fullName = match?.[1];
    if (!fullName || fullName === "<anonymous>") continue;
    const name = fullName.split(".").at(-1);
    if (!name || name === "db" || name === "callerFunctionName") continue;
    return name;
  }
  return undefined;
}

function db(env: Env) {
  const sourceSymbol = callerFunctionName(new Error().stack);
  return drizzle(
    async (sql, params, method) => {
      const resp = await fetch(env.WEBSITE_DB_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.WEBSITE_DB_TOKEN}`,
        },
        body: JSON.stringify({
          sql,
          params,
          method,
          ...(sourceSymbol ? { sourceSymbol, sourceSymbolKind: "function" } : {}),
        }),
      });
      if (!resp.ok) {
        throw new Error(`database query failed: ${resp.status} ${await resp.text()}`);
      }
      const data = (await resp.json()) as { rows?: unknown[] };
      return {
        rows: (data.rows ?? []).map((row) =>
          Array.isArray(row) ? row : Object.values(row as Record<string, unknown>)
        ),
      };
    },
    { schema: { users, sessions, providerAccounts, refreshRequests, transactions, bridgeTokens } }
  );
}

// ---------- crypto helpers ----------

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256
  );
  return `${toB64(salt)}:${toB64(bits)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(":");
  if (!saltB64 || !hashB64) return false;
  const salt = fromB64(saltB64);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    key,
    256
  );
  return toB64(bits) === hashB64;
}

async function encryptForBridge(plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    BRIDGE_PUBLIC_JWK,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    new TextEncoder().encode(plaintext)
  );
  return toB64(ciphertext);
}

function newId(): string {
  return crypto.randomUUID();
}

// ---------- auth middleware ----------

type AuthedUser = { id: string; email: string; tier: string };

async function currentUser(c: Context<{ Bindings: Env }>): Promise<AuthedUser | null> {
  const token = getCookie(c, "sid");
  if (!token) return null;
  const now = Date.now();
  const rows = await db(c.env)
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.token, token))
    .all();
  const session = rows[0];
  if (!session || session.expiresAt < now) return null;
  const userRows = await db(c.env)
    .select({ id: users.id, email: users.email, tier: users.tier })
    .from(users)
    .where(eq(users.id, session.userId))
    .all();
  return userRows[0] ?? null;
}

async function requireUser(c: Context<{ Bindings: Env }>): Promise<AuthedUser | Response> {
  const u = await currentUser(c);
  if (!u) return c.json({ error: "not authenticated" }, 401);
  return u;
}

function isUser(x: AuthedUser | Response): x is AuthedUser {
  return !(x instanceof Response);
}

// ---------- auth routes ----------

app.post("/api/auth/signup", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !email.includes("@") || password.length < 8) {
    return c.json({ error: "valid email and password (min 8 chars) are required" }, 400);
  }
  const existing = await db(c.env).select({ id: users.id }).from(users).where(eq(users.email, email)).all();
  if (existing.length > 0) {
    return c.json({ error: "an account with this email already exists" }, 409);
  }
  const id = newId();
  const passwordHash = await hashPassword(password);
  await db(c.env).insert(users).values({ id, email, passwordHash, tier: "standard", createdAt: Date.now() });
  await startSession(c, id);
  return c.json({ user: { id, email, tier: "standard" } }, 201);
});

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const rows = await db(c.env).select().from(users).where(eq(users.email, email)).all();
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: "invalid email or password" }, 401);
  }
  await startSession(c, user.id);
  return c.json({ user: { id: user.id, email: user.email, tier: user.tier } });
});

async function startSession(c: Context<{ Bindings: Env }>, userId: string) {
  const token = newId() + newId();
  const now = Date.now();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
  await db(c.env).insert(sessions).values({ token, userId, createdAt: now, expiresAt });
  setCookie(c, "sid", token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, "sid");
  if (token) {
    await db(c.env).delete(sessions).where(eq(sessions.token, token));
  }
  deleteCookie(c, "sid", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => {
  const u = await currentUser(c);
  return c.json({ user: u });
});

// ---------- provider accounts ----------

app.get("/api/providers", (c) => c.json({ providers: PROVIDERS }));

app.get("/api/accounts", async (c) => {
  const u = await requireUser(c);
  if (!isUser(u)) return u;
  const rows = await db(c.env)
    .select({
      id: providerAccounts.id,
      provider: providerAccounts.provider,
      providerUsername: providerAccounts.providerUsername,
      active: providerAccounts.active,
      lastRefreshedAt: providerAccounts.lastRefreshedAt,
      createdAt: providerAccounts.createdAt,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, u.id))
    .all();
  if (rows.length === 0) return c.json({ accounts: [] });

  // Latest refresh attempt per account, so a subscriber can see *why* a pull
  // failed (expired password, CAPTCHA, ...) instead of just a stale
  // "last refreshed" date that never moves.
  const allRequests = await db(c.env)
    .select({
      providerAccountId: refreshRequests.providerAccountId,
      status: refreshRequests.status,
      message: refreshRequests.message,
      requestedAt: refreshRequests.requestedAt,
    })
    .from(refreshRequests)
    .where(eq(refreshRequests.userId, u.id))
    .all();
  const latestRequestByAccount = new Map<string, (typeof allRequests)[number]>();
  for (const r of allRequests) {
    const prev = latestRequestByAccount.get(r.providerAccountId);
    if (!prev || r.requestedAt > prev.requestedAt) latestRequestByAccount.set(r.providerAccountId, r);
  }

  // "Account since" the provider's own records show activity from — not the
  // date the subscriber happened to connect it here on the site.
  const allTx = await db(c.env)
    .select({ providerAccountId: transactions.providerAccountId, occurredAt: transactions.occurredAt })
    .from(transactions)
    .where(eq(transactions.userId, u.id))
    .all();
  const earliestTxByAccount = new Map<string, number>();
  for (const t of allTx) {
    const prev = earliestTxByAccount.get(t.providerAccountId);
    if (prev === undefined || t.occurredAt < prev) earliestTxByAccount.set(t.providerAccountId, t.occurredAt);
  }

  const accounts = rows.map((a) => {
    const latest = latestRequestByAccount.get(a.id);
    return {
      ...a,
      lastRefreshStatus: latest?.status ?? null,
      lastRefreshMessage: latest?.message ?? null,
      providerSince: earliestTxByAccount.get(a.id) ?? null,
    };
  });
  return c.json({ accounts });
});

app.post("/api/accounts", async (c) => {
  const u = await requireUser(c);
  if (!isUser(u)) return u;
  const body = await c.req.json<{ provider?: string; username?: string; password?: string }>();
  const provider = body.provider as Provider;
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  if (!PROVIDERS.includes(provider)) {
    return c.json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` }, 400);
  }
  if (!username || !password) {
    return c.json({ error: "username and password are required" }, 400);
  }
  const id = newId();
  const now = Date.now();
  const [usernameEnc, passwordEnc] = await Promise.all([
    encryptForBridge(username),
    encryptForBridge(password),
  ]);
  await db(c.env).insert(providerAccounts).values({
    id,
    userId: u.id,
    provider,
    providerUsername: username,
    usernameEnc,
    passwordEnc,
    active: 1,
    createdAt: now,
  });
  await db(c.env).insert(refreshRequests).values({
    id: newId(),
    providerAccountId: id,
    userId: u.id,
    provider,
    status: "pending",
    requestedAt: now,
  });
  return c.json({ account: { id, provider, providerUsername: username, active: true, createdAt: now } }, 201);
});

app.patch("/api/accounts/:id", async (c) => {
  const u = await requireUser(c);
  if (!isUser(u)) return u;
  const id = c.req.param("id");
  const body = await c.req.json<{ active?: boolean }>();
  const owned = await db(c.env)
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(and(eq(providerAccounts.id, id), eq(providerAccounts.userId, u.id)))
    .all();
  if (owned.length === 0) return c.json({ error: "account not found" }, 404);
  if (typeof body.active === "boolean") {
    await db(c.env)
      .update(providerAccounts)
      .set({ active: body.active ? 1 : 0 })
      .where(eq(providerAccounts.id, id));
  }
  return c.json({ ok: true });
});

app.delete("/api/accounts/:id", async (c) => {
  const u = await requireUser(c);
  if (!isUser(u)) return u;
  const id = c.req.param("id");
  const owned = await db(c.env)
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(and(eq(providerAccounts.id, id), eq(providerAccounts.userId, u.id)))
    .all();
  if (owned.length === 0) return c.json({ error: "account not found" }, 404);
  await db(c.env).delete(transactions).where(eq(transactions.providerAccountId, id));
  await db(c.env).delete(refreshRequests).where(eq(refreshRequests.providerAccountId, id));
  await db(c.env).delete(providerAccounts).where(eq(providerAccounts.id, id));
  return c.json({ ok: true });
});

app.post("/api/accounts/:id/refresh", async (c) => {
  const u = await requireUser(c);
  if (!isUser(u)) return u;
  const id = c.req.param("id");
  const owned = await db(c.env)
    .select({ id: providerAccounts.id, provider: providerAccounts.provider })
    .from(providerAccounts)
    .where(and(eq(providerAccounts.id, id), eq(providerAccounts.userId, u.id)))
    .all();
  const account = owned[0];
  if (!account) return c.json({ error: "account not found" }, 404);
  const existingPending = await db(c.env)
    .select({ id: refreshRequests.id })
    .from(refreshRequests)
    .where(
      and(
        eq(refreshRequests.providerAccountId, id),
        rawSql`${refreshRequests.status} in ('pending','running')`
      )
    )
    .all();
  if (existingPending.length > 0) {
    return c.json({ ok: true, message: "a refresh is already queued for this account" });
  }
  await db(c.env).insert(refreshRequests).values({
    id: newId(),
    providerAccountId: id,
    userId: u.id,
    provider: account.provider,
    status: "pending",
    requestedAt: Date.now(),
  });
  return c.json({ ok: true }, 201);
});

// ---------- dashboard ----------

app.get("/api/dashboard/summary", async (c) => {
  const u = await requireUser(c);
  if (!isUser(u)) return u;
  // Totals only count *active* accounts — deactivating an account (e.g. a
  // closed prop-firm account) removes it from the headline numbers without
  // deleting its history, mirroring the private tracker's active-for-total
  // control.
  const allAccountRows = await db(c.env)
    .select({
      id: providerAccounts.id,
      provider: providerAccounts.provider,
      providerUsername: providerAccounts.providerUsername,
      active: providerAccounts.active,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, u.id))
    .all();
  const activeAccountIds = new Set(allAccountRows.filter((a) => a.active === 1).map((a) => a.id));
  const providerByAccount = new Map(allAccountRows.map((a) => [a.id, a.provider]));

  const rows = await db(c.env)
    .select({
      providerAccountId: transactions.providerAccountId,
      kind: transactions.kind,
      status: transactions.status,
      amountCents: transactions.amountCents,
      externalId: transactions.externalId,
      occurredAt: transactions.occurredAt,
    })
    .from(transactions)
    .where(eq(transactions.userId, u.id))
    .all();

  type Breakdown = {
    provider?: string;
    totalPaidCents: number;
    totalPayoutCents: number;
    netCostCents: number;
    activeAccountCount: number;
    totalAccountCount: number;
  };
  const emptyBreakdown = (provider?: string): Breakdown => ({
    provider,
    totalPaidCents: 0,
    totalPayoutCents: 0,
    netCostCents: 0,
    activeAccountCount: 0,
    totalAccountCount: 0,
  });

  let totalPaidCents = 0;
  let totalPayoutCents = 0;
  const byProvider: Record<string, Breakdown> = {};
  for (const p of PROVIDERS) byProvider[p] = emptyBreakdown();
  const byUser: Record<string, Breakdown> = {};
  for (const a of allAccountRows) {
    byProvider[a.provider].totalAccountCount += 1;
    if (a.active === 1) byProvider[a.provider].activeAccountCount += 1;
    const key = a.providerUsername;
    if (!byUser[key]) byUser[key] = emptyBreakdown(a.provider);
    byUser[key].totalAccountCount += 1;
    if (a.active === 1) byUser[key].activeAccountCount += 1;
  }
  const usernameByAccount = new Map(allAccountRows.map((a) => [a.id, a.providerUsername]));

  // Latest transaction per (account, subscription externalId) tells us
  // whether that specific subscription is still active right now — a
  // subscription-kind row is one billing event, not a live status, so the
  // most recent event per subscription id stands in for "current state".
  const latestSubEventByKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.kind !== "subscription") continue;
    const key = `${r.providerAccountId}:${r.externalId}`;
    const prev = latestSubEventByKey.get(key);
    if (!prev || r.occurredAt > prev.occurredAt) latestSubEventByKey.set(key, r);
  }
  let activeSubscriptions = 0;
  let cancelledSubscriptions = 0;
  let activeSubscriptionMonthlyCents = 0;
  for (const r of latestSubEventByKey.values()) {
    if (r.status === "successful") {
      activeSubscriptions += 1;
      if (activeAccountIds.has(r.providerAccountId)) activeSubscriptionMonthlyCents += r.amountCents;
    } else if (r.status === "failed") {
      cancelledSubscriptions += 1;
    }
  }

  for (const r of rows) {
    if (!activeAccountIds.has(r.providerAccountId)) continue; // deactivated account: excluded from totals
    if (r.status !== "successful") continue;
    const provider = providerByAccount.get(r.providerAccountId);
    const username = usernameByAccount.get(r.providerAccountId);
    if (r.kind === "charge" || r.kind === "subscription") {
      totalPaidCents += r.amountCents;
      if (provider) byProvider[provider].totalPaidCents += r.amountCents;
      if (username) byUser[username].totalPaidCents += r.amountCents;
    } else if (r.kind === "payout") {
      totalPayoutCents += r.amountCents;
      if (provider) byProvider[provider].totalPayoutCents += r.amountCents;
      if (username) byUser[username].totalPayoutCents += r.amountCents;
    }
  }
  for (const b of [...Object.values(byProvider), ...Object.values(byUser)]) {
    b.netCostCents = b.totalPaidCents - b.totalPayoutCents;
  }

  return c.json({
    totalPaidCents,
    totalPayoutCents,
    netCostCents: totalPaidCents - totalPayoutCents,
    activeSubscriptionMonthlyCents,
    tier: u.tier,
    byProvider,
    byUser,
    subscriptions: { active: activeSubscriptions, cancelled: cancelledSubscriptions },
  });
});

app.get("/api/dashboard/transactions", async (c) => {
  const u = await requireUser(c);
  if (!isUser(u)) return u;
  const provider = c.req.query("provider");
  const kind = c.req.query("kind");
  const conditions = [eq(transactions.userId, u.id)];
  if (provider) conditions.push(eq(transactions.provider, provider));
  if (kind) conditions.push(eq(transactions.kind, kind));
  const rows = await db(c.env)
    .select()
    .from(transactions)
    .where(and(...conditions))
    .all();
  rows.sort((a, b) => b.occurredAt - a.occurredAt);
  return c.json({ transactions: rows.slice(0, 500) });
});

app.get("/api/dashboard/subscriptions", async (c) => {
  const u = await requireUser(c);
  if (!isUser(u)) return u;
  const rows = await db(c.env)
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, u.id), eq(transactions.kind, "subscription")))
    .all();
  rows.sort((a, b) => b.occurredAt - a.occurredAt);
  return c.json({ subscriptions: rows });
});

// ---------- internal bridge (agent-side automation, not a subscriber) ----------
// No cron/browser automation runs inside this worker. The owning agent polls
// these endpoints on a schedule, decrypts credentials locally with the
// private key matching BRIDGE_PUBLIC_JWK, performs the actual provider
// login + data pull, and reports results back here.

app.post("/api/internal/bootstrap-bridge-token", async (c) => {
  const existing = await db(c.env).select({ id: bridgeTokens.id }).from(bridgeTokens).all();
  if (existing.length > 0) {
    return c.json({ error: "bridge token already initialized" }, 403);
  }
  const token = toB64(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  await db(c.env).insert(bridgeTokens).values({ id: newId(), tokenHash, createdAt: Date.now() });
  return c.json({ token }, 201);
});

async function requireBridgeToken(c: Context<{ Bindings: Env }>): Promise<true | Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return c.json({ error: "missing bridge token" }, 401);
  const hash = await sha256Hex(token);
  const rows = await db(c.env)
    .select({ id: bridgeTokens.id })
    .from(bridgeTokens)
    .where(eq(bridgeTokens.tokenHash, hash))
    .all();
  if (rows.length === 0) return c.json({ error: "invalid bridge token" }, 401);
  return true;
}

app.get("/api/internal/refresh-queue", async (c) => {
  const auth = await requireBridgeToken(c);
  if (auth !== true) return auth;
  const pending = await db(c.env)
    .select()
    .from(refreshRequests)
    .where(eq(refreshRequests.status, "pending"))
    .all();
  const results = [];
  for (const req of pending) {
    const accRows = await db(c.env)
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, req.providerAccountId))
      .all();
    const account = accRows[0];
    if (!account) continue;
    await db(c.env).update(refreshRequests).set({ status: "running" }).where(eq(refreshRequests.id, req.id));
    results.push({
      requestId: req.id,
      providerAccountId: account.id,
      userId: account.userId,
      provider: account.provider,
      usernameEnc: account.usernameEnc,
      passwordEnc: account.passwordEnc,
    });
  }
  return c.json({ requests: results });
});

app.post("/api/internal/refresh-result", async (c) => {
  const auth = await requireBridgeToken(c);
  if (auth !== true) return auth;
  const body = await c.req.json<{
    requestId?: string;
    status?: "done" | "failed";
    message?: string;
    transactions?: Array<{
      externalId: string;
      kind: string;
      amountCents: number;
      currency?: string;
      status: string;
      occurredAt: number;
      rawJson?: string;
    }>;
  }>();
  const requestId = body.requestId ?? "";
  const rows = await db(c.env).select().from(refreshRequests).where(eq(refreshRequests.id, requestId)).all();
  const req = rows[0];
  if (!req) return c.json({ error: "unknown requestId" }, 404);
  const now = Date.now();
  if (body.status === "done") {
    for (const t of body.transactions ?? []) {
      const txId = `${req.providerAccountId}:${t.kind}:${t.externalId}`;
      await db(c.env)
        .insert(transactions)
        .values({
          id: txId,
          providerAccountId: req.providerAccountId,
          userId: req.userId,
          provider: req.provider,
          kind: t.kind,
          externalId: t.externalId,
          amountCents: t.amountCents,
          currency: t.currency ?? "USD",
          status: t.status,
          occurredAt: t.occurredAt,
          rawJson: t.rawJson ?? null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: transactions.id,
          set: {
            amountCents: t.amountCents,
            status: t.status,
            occurredAt: t.occurredAt,
            rawJson: t.rawJson ?? null,
            updatedAt: now,
          },
        });
    }
    await db(c.env)
      .update(refreshRequests)
      .set({ status: "done", completedAt: now, message: body.message ?? `${body.transactions?.length ?? 0} transactions` })
      .where(eq(refreshRequests.id, requestId));
    await db(c.env)
      .update(providerAccounts)
      .set({ lastRefreshedAt: now })
      .where(eq(providerAccounts.id, req.providerAccountId));
  } else {
    await db(c.env)
      .update(refreshRequests)
      .set({ status: "failed", completedAt: now, message: body.message ?? "refresh failed" })
      .where(eq(refreshRequests.id, requestId));
  }
  return c.json({ ok: true });
});

export default app;
