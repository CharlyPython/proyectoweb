# Design direction

## Design read
A subscription SaaS dashboard for prop-firm traders, designed to let each trader track what they actually spend and earn across their own Tradeify/Bulenox accounts, using a disciplined trading-terminal direction grounded in real financial data (money in/out, account status, per-provider grouping).

## Goal and audience
- Subject: PropFirm Cost Tracker — a multi-tenant web app where each signed-up trader registers their own Tradeify/Bulenox login, and the app aggregates their spend, payouts, and net across all their accounts.
- Audience: retail futures/forex prop-firm traders who juggle multiple funded-account subscriptions and want one place to see total cost vs. payout. Trust matters a lot — they are handing over real broker credentials, so the UI must read as competent and secure, not a hobby project.
- Single job: sign up, connect provider accounts, see net cost/profit at a glance.
- Real assets and proof: none supplied yet — this is a new product, no logo, no screenshots, no testimonials.
- Missing material and draft placeholders: no real logo (use a simple wordmark/monogram), no testimonials (omit entirely rather than fabricate), no real pricing copy beyond the confirmed VIP price (2.99/mo) — Standard is free/base tier, VIP benefits are intentionally undefined for now so the UI shows VIP as "available" without overclaiming features (label as "More VIP perks coming soon").

## Dials
- Design variance: 3/10 — financial tools earn trust through regularity, not surprise.
- Motion intensity: 2/10 — minimal, only state feedback (loading, success/fail on refresh).
- Visual density: 6/10 — traders want numbers on screen (totals, per-provider breakdown), not whitespace.

## Visual system
- Color:
  - canvas: #0B0F14 (near-black slate)
  - surface: #121821 (card backgrounds)
  - primary text: #E6EDF3
  - secondary text: #8B98A5
  - action (primary): #22C55E (P&L green — money-positive, fits trading context)
  - accent (VIP / warning): #F5A623 (amber, used only for VIP badge and negative deltas use a separate #EF4444 red)
- Typography:
  - Display: "Inter", weight 600–700, used for totals and headline numbers — tabular-nums for figures so columns align.
  - Body/utility: "Inter", weight 400–500, 14–16px base, 1.5 line height.
  - Monospace accent ("JetBrains Mono" fallback to ui-monospace) for account IDs / usernames only.
- Layout and responsive behavior:
  - Top bar: wordmark left, tier badge (Standard/VIP) + user menu right.
  - Dashboard: a KPI row (Total Spend, Total Payouts, Net) as 3 cards, then a providers section (Tradeify / Bulenox tabs or side-by-side cards) listing the user's own accounts with per-account status (last refreshed, refresh button), then a transactions table below.
  - Narrow screen: KPI cards stack to 1 column, provider cards stack, table becomes horizontally scrollable with sticky first column.
  - Content width: max 1100px centered, 24px page padding on mobile.
  - Cards: 12px radius, 1px hairline border (#1E2733), no heavy shadows (flat, terminal-like).
- Signature: the KPI row's numbers are the signature — large tabular-figure totals with a small colored delta chip (▲/▼) next to Net, reinforcing "this is a money tracker" even with the logo hidden.
- Imagery and motion: no photography needed (financial dashboard, not a lifestyle product). One motion idea: a subtle skeleton-shimmer while a refresh request is running, replaced by a checkmark flash on completion. No hero illustration.
- Image production plan: 0 images needed for v1 — pure UI/typography product, generating stock-style imagery would look generic and hurt trust. Skip image generation entirely.

## Content structure
1. **Landing / marketing screen** (logged out): headline ("Track every dollar you put into your prop-firm accounts"), one-line subhead, CTA "Create free account", small tier comparison (Standard vs VIP, VIP price 2.99/mo, VIP marked "more perks coming soon").
2. **Auth**: single screen toggling Sign up / Log in.
3. **Dashboard (logged in)**: KPI row → Provider accounts (add-account form modal, per-account refresh + status) → Transactions table (filterable by provider/account) → empty state ("Connect your first prop-firm account to see numbers here") when no accounts exist yet.
