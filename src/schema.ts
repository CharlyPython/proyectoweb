import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Subscribers of the PropFirm Cost Tracker SaaS. tier gates VIP features later;
// VIP benefits are intentionally undefined for now — the column exists so the
// upgrade flow can be wired without a schema change.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  tier: text("tier").notNull().default("standard"), // 'standard' | 'vip'
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

// Each subscriber's own login for a shared provider catalog (tradeify | bulenox).
// provider_username / provider_password_enc travel encrypted (RSA-OAEP under the
// bridge public key baked into the worker) so a DB dump never exposes a
// plaintext broker credential; only the agent-side bridge holding the private
// key can decrypt them to actually log in and refresh.
export const providerAccounts = sqliteTable("provider_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(), // 'tradeify' | 'bulenox'
  providerUsername: text("provider_username").notNull(),
  usernameEnc: text("username_enc").notNull(),
  passwordEnc: text("password_enc").notNull(),
  active: integer("active").notNull().default(1),
  lastRefreshedAt: integer("last_refreshed_at"),
  createdAt: integer("created_at").notNull(),
});

// Queue processed by the agent-side bridge (this site has no cron of its own).
export const refreshRequests = sqliteTable("refresh_requests", {
  id: text("id").primaryKey(),
  providerAccountId: text("provider_account_id").notNull(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull().default("pending"), // pending | running | done | failed
  message: text("message"),
  requestedAt: integer("requested_at").notNull(),
  completedAt: integer("completed_at"),
});

// Normalized financial rows pushed back by the bridge after a successful pull.
// kind: 'charge' | 'subscription' (spend) | 'payout' (income). id is namespaced
// per account+kind+externalId so re-pulls upsert instead of duplicating.
export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(),
  providerAccountId: text("provider_account_id").notNull(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  externalId: text("external_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull(), // successful | failed | pending | unknown
  occurredAt: integer("occurred_at").notNull(),
  rawJson: text("raw_json"),
  updatedAt: integer("updated_at").notNull(),
});

// One-time bootstrap secret for the agent-side bridge (see worker.ts). Only a
// hash is ever stored; the plaintext token is returned exactly once at
// bootstrap time and never persisted in site source or DB.
export const bridgeTokens = sqliteTable("bridge_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});
