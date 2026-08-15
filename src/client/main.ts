// PropFirm Cost Tracker — client SPA (vanilla TS, no framework: small surface,
// matches DESIGN.md's disciplined terminal-style direction).
//
// Layout mirrors the owner's private tracker Page: a persistent right-side
// Dashboard/Payments nav, and — only in the Payments view — a left-side
// filter panel (group by, account, rows to show). "byUser" groups by each
// provider-account's own username, since this SaaS has one subscriber per
// login (no separate multi-user concept beyond that).

type User = { id: string; email: string; tier: string };
type Account = {
  id: string;
  provider: string;
  providerUsername: string;
  active: number;
  lastRefreshedAt: number | null;
  createdAt: number;
  lastRefreshStatus: string | null;
  lastRefreshMessage: string | null;
  providerSince: number | null;
};
type Tx = {
  id: string;
  provider: string;
  kind: string;
  externalId: string;
  amountCents: number;
  currency: string;
  status: string;
  occurredAt: number;
  providerAccountId: string;
};
type Breakdown = {
  provider?: string;
  totalPaidCents: number;
  totalPayoutCents: number;
  netCostCents: number;
  activeAccountCount: number;
  totalAccountCount: number;
};
type Summary = {
  totalPaidCents: number;
  totalPayoutCents: number;
  netCostCents: number;
  activeSubscriptionMonthlyCents: number;
  tier: string;
  byProvider: Record<string, Breakdown>;
  byUser: Record<string, Breakdown>;
  subscriptions: { active: number; cancelled: number };
};

const root = document.querySelector<HTMLDivElement>("#app")!;
const PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100] as const;

// ---------- module state ----------
let accountsPageSize = PAGE_SIZE_OPTIONS[0];
let accountsPage = 0;

let currentView: "dashboard" | "payments" = "dashboard";
let dashboardTab: "payments" | "subscriptions" | "payouts" | "accounts" | "users" = "payments";
let breakdownMode: "provider" | "user" = "provider";

let paymentsGroupBy: "user" | "provider" = "user";
let paymentsAccountFilter = "all";
let paymentsRowsPerGroup: number | "all" = 5;

// Shared cache so the Payments view can label a transaction's account
// without a fresh fetch every time a filter changes.
let cachedAccounts: Account[] = [];
let cachedChargeTx: Tx[] = [];

// ---------- icons ----------

function tabIcon(
  kind: "payments" | "subscriptions" | "payouts" | "accounts" | "users" | "propfirm" | "dashboard"
): string {
  const paths: Record<string, string> = {
    payments: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h4"/>',
    subscriptions: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 2v4M17 2v4M3 10h18"/>',
    payouts: '<path d="M3 20h18M6 20V10M12 20V4M18 20v-7"/>',
    accounts: '<path d="M3 21h18M5 21V9l7-6 7 6v12M9 21v-6h6v6"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3 3-5 7-5s7 2 7 5M17 8a3 3 0 1 0 0-6M15 14c3 0 6 1.7 7 4v2"/>',
    propfirm: '<path d="M3 21h18M5 21V7l6-4 6 4v14M9 21v-4h6v4M9 12h.01M15 12h.01M9 9h.01M15 9h.01"/>',
    dashboard:
      '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  };
  return `<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`;
}

function kpiIcon(kind: "paid" | "payout" | "net" | "sub"): string {
  const paths: Record<string, string> = {
    paid: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/>',
    payout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h.01M12 14h4"/>',
    net: '<circle cx="8" cy="12" r="5"/><circle cx="15" cy="12" r="5" opacity="0.5"/>',
    sub: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  };
  return `<svg class="kpi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`;
}

// ---------- formatting ----------

function money(cents: number, currency = "USD"): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency });
}

function fmtDate(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleString();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

// ---------- generic bar chart (used by income/expense, breakdown, paid-vs-payouts) ----------

function renderSimpleBarChart(
  el: HTMLDivElement,
  entries: { label: string; value: number; color?: string }[],
  opts: { height?: number; showValue?: boolean } = {}
) {
  if (entries.length === 0) {
    el.innerHTML = `<div class="empty-state">No data yet.</div>`;
    return;
  }
  const height = opts.height ?? 220;
  const max = Math.max(1, ...entries.map((e) => Math.abs(e.value)));
  const colors = ["#3B82F6", "#F5A623", "#22C55E", "#EF4444", "#A855F7", "#14B8A6"];
  el.innerHTML = `
    <div class="bar-chart" style="height:${height}px">
      ${entries
        .map((e, i) => {
          const pct = Math.max(2, Math.round((Math.abs(e.value) / max) * 100));
          return `
        <div class="bar-col">
          <div class="bar-track"><div class="bar-fill" style="height:${pct}%;background:${e.color ?? colors[i % colors.length]}"></div></div>
          <div class="bar-tick">${escapeHtml(e.label)}${opts.showValue ? `<br><span class="bar-tick-value">${money(e.value)}</span>` : ""}</div>
        </div>`;
        })
        .join("")}
    </div>
  `;
}

function renderIncomeExpenseChart(summary: Summary, selector: string) {
  const el = document.querySelector<HTMLDivElement>(selector)!;
  renderSimpleBarChart(
    el,
    [
      { label: "Total paid (expenses)", value: summary.totalPaidCents ?? 0, color: "#EF4444" },
      { label: "Total payouts (income)", value: summary.totalPayoutCents ?? 0, color: "#22C55E" },
    ],
    { height: 180, showValue: true }
  );
}

function renderBreakdown(summary: Summary, mode: "provider" | "user", chartSelector: string, tableSelector: string) {
  const chartEl = document.querySelector<HTMLDivElement>(chartSelector)!;
  const tableEl = document.querySelector<HTMLDivElement>(tableSelector)!;
  const source = mode === "provider" ? summary.byProvider ?? {} : summary.byUser ?? {};
  const entries = Object.entries(source).filter(([, b]) => b.totalAccountCount > 0 || b.totalPaidCents !== 0);
  const firstColLabel = mode === "provider" ? "Prop firm" : "User";

  if (entries.length === 0) {
    chartEl.innerHTML = "";
    tableEl.innerHTML = `<div class="empty-state">No data yet for this breakdown.</div>`;
    return;
  }

  renderSimpleBarChart(
    chartEl,
    entries.map(([key, b]) => ({ label: key, value: b.totalPaidCents })),
    { height: 220 }
  );

  tableEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>${firstColLabel}</th>
          <th style="text-align:right">Total paid</th>
          <th style="text-align:right">Total payouts</th>
          <th style="text-align:right">Net cost</th>
          <th>Accounts</th>
        </tr>
      </thead>
      <tbody>
        ${entries
          .map(
            ([key, b]) => `
          <tr>
            <td style="text-transform:capitalize">${escapeHtml(key)}</td>
            <td class="amount">${money(b.totalPaidCents)}</td>
            <td class="amount">${money(b.totalPayoutCents)}</td>
            <td class="amount">${money(b.netCostCents)}</td>
            <td>${b.activeAccountCount} active / ${b.totalAccountCount} total</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderPaidPayoutsChart(summary: Summary, mode: "provider" | "user", selector: string) {
  const el = document.querySelector<HTMLDivElement>(selector)!;
  const source = mode === "provider" ? summary.byProvider ?? {} : summary.byUser ?? {};
  const entries = Object.entries(source).filter(
    ([, b]) => b.totalAccountCount > 0 || b.totalPaidCents !== 0 || b.totalPayoutCents !== 0
  );
  const bars = entries.flatMap(([key, b]) => [
    { label: `${key} · paid`, value: b.totalPaidCents, color: "#EF4444" },
    { label: `${key} · payouts`, value: b.totalPayoutCents, color: "#22C55E" },
  ]);
  renderSimpleBarChart(el, bars, { height: 220, showValue: true });
}

// ---------- boot / auth ----------

async function boot() {
  const me = await api<{ user: User | null }>("/api/auth/me");
  if (me.data.user) {
    renderDashboard(me.data.user);
  } else {
    renderAuth("login");
  }
}

function renderAuth(mode: "login" | "signup") {
  root.innerHTML = `
    <div class="auth-screen">
      <div class="card auth-card">
        <div class="auth-title">PropFirm<span style="color:var(--action)">.</span>Cost Tracker</div>
        <div class="auth-sub">${mode === "login" ? "Log in to your dashboard" : "Create your free account"}</div>
        <form id="auth-form">
          <div class="field">
            <label>Email</label>
            <input type="email" id="email" required />
          </div>
          <div class="field">
            <label>Password</label>
            <input type="password" id="password" required minlength="8" />
          </div>
          <button type="submit" class="primary" style="width:100%">${mode === "login" ? "Log in" : "Sign up"}</button>
          <div class="error-text" id="auth-error" style="display:none"></div>
        </form>
        <div class="auth-toggle">
          ${
            mode === "login"
              ? `No account yet? <a id="toggle-mode">Sign up</a>`
              : `Already have an account? <a id="toggle-mode">Log in</a>`
          }
        </div>
        <div class="tier-plans">
          <div class="plan-card">
            <h4>Standard</h4>
            <div class="price">Free</div>
            <div class="note">Track your prop-firm accounts and costs.</div>
          </div>
          <div class="plan-card">
            <h4>VIP</h4>
            <div class="price">$2.99<span style="font-size:12px;color:var(--text-secondary)">/mo</span></div>
            <div class="note">More VIP perks coming soon.</div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.querySelector("#toggle-mode")?.addEventListener("click", () => {
    renderAuth(mode === "login" ? "signup" : "login");
  });

  document.querySelector("#auth-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = (document.querySelector<HTMLInputElement>("#email")!).value;
    const password = (document.querySelector<HTMLInputElement>("#password")!).value;
    const errEl = document.querySelector<HTMLDivElement>("#auth-error")!;
    errEl.style.display = "none";
    const path = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
    const res = await api<{ user?: User; error?: string }>(path, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok || !res.data.user) {
      errEl.textContent = res.data.error ?? "Something went wrong";
      errEl.style.display = "block";
      return;
    }
    renderDashboard(res.data.user);
  });
}

// ---------- shell: topbar + right nav + (payments-only) left filters ----------

async function renderDashboard(user: User) {
  root.innerHTML = `
    <div class="topbar">
      <div class="wordmark">PropFirm<span>.</span>Cost Tracker</div>
      <div class="user-menu">
        <span class="tier-badge ${user.tier}">${user.tier === "vip" ? "★ VIP" : "Standard"}</span>
        <span style="color:var(--text-secondary);font-size:13px">${user.email}</span>
        <button id="logout-btn" class="ghost">Log out</button>
      </div>
    </div>
    <div class="shell">
      <div class="shell-left" id="shell-left"></div>
      <div class="shell-main" id="shell-main">Loading…</div>
    </div>
  `;

  document.querySelector("#logout-btn")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    renderAuth("login");
  });

  await loadShellBody(user);
}

function renderLeftColumn(user: User) {
  const el = document.querySelector<HTMLDivElement>("#shell-left")!;
  el.innerHTML = `
    <div class="card side-nav-card">
      <button class="side-nav-link ${currentView === "dashboard" ? "active" : ""}" data-nav="dashboard">${tabIcon("dashboard")}<span>Dashboard</span></button>
      <button class="side-nav-link ${currentView === "payments" ? "active" : ""}" data-nav="payments">${tabIcon("payments")}<span>Payments</span></button>
    </div>
    ${
      currentView === "payments"
        ? `
    <div class="card">
      <div class="filters-title">Payment filters</div>
      <div class="field">
        <label>Group by</label>
        <div class="segmented" id="pay-groupby-seg">
          <button type="button" class="seg-btn ${paymentsGroupBy === "user" ? "active" : ""}" data-v="user">User</button>
          <button type="button" class="seg-btn ${paymentsGroupBy === "provider" ? "active" : ""}" data-v="provider">Prop firm</button>
        </div>
      </div>
      <div class="field">
        <label for="pay-account-filter">Account</label>
        <select id="pay-account-filter"><option value="all">All accounts</option></select>
      </div>
      <div class="field">
        <label for="pay-rows-filter">Rows to show</label>
        <select id="pay-rows-filter">
          ${[...PAGE_SIZE_OPTIONS, "all"]
            .map(
              (n) =>
                `<option value="${n}" ${String(n) === String(paymentsRowsPerGroup) ? "selected" : ""}>${n === "all" ? "All" : n}</option>`
            )
            .join("")}
        </select>
      </div>
    </div>`
        : ""
    }
  `;

  el.querySelectorAll<HTMLButtonElement>(".side-nav-link").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const nav = btn.dataset.nav as "dashboard" | "payments";
      if (nav === currentView) return;
      currentView = nav;
      await loadShellBody(user);
    })
  );

  if (currentView !== "payments") return;
  el.querySelectorAll<HTMLButtonElement>("#pay-groupby-seg .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      paymentsGroupBy = btn.dataset.v as "user" | "provider";
      el.querySelectorAll("#pay-groupby-seg .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderPaymentsGroupedView();
    })
  );
  el.querySelector<HTMLSelectElement>("#pay-rows-filter")?.addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    paymentsRowsPerGroup = v === "all" ? "all" : Number(v);
    renderPaymentsGroupedView();
  });
  el.querySelector<HTMLSelectElement>("#pay-account-filter")?.addEventListener("change", (e) => {
    paymentsAccountFilter = (e.target as HTMLSelectElement).value;
    renderPaymentsGroupedView();
  });
}

function populateAccountFilterOptions() {
  const sel = document.querySelector<HTMLSelectElement>("#pay-account-filter");
  if (!sel) return;
  const opts = cachedAccounts.map((a) => ({ value: a.id, label: `${a.providerUsername} · ${a.provider}` }));
  if (!opts.some((o) => o.value === paymentsAccountFilter)) paymentsAccountFilter = "all";
  sel.innerHTML = `<option value="all">All accounts</option>${opts
    .map((o) => `<option value="${o.value}" ${o.value === paymentsAccountFilter ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("")}`;
}

async function loadShellBody(user: User) {
  renderLeftColumn(user);
  const mainEl = document.querySelector<HTMLDivElement>("#shell-main")!;
  mainEl.innerHTML = "Loading…";
  if (currentView === "payments") {
    const accountsRes = await api<{ accounts: Account[] }>("/api/accounts");
    const txRes = await api<{ transactions: Tx[] }>("/api/dashboard/transactions?kind=charge");
    cachedAccounts = accountsRes.data.accounts ?? [];
    cachedChargeTx = txRes.data.transactions ?? [];
    populateAccountFilterOptions();
    renderPaymentsGroupedView();
  } else {
    await loadDashboardMain(user);
  }
}

// ---------- Payments view (top-level nav): grouped accordion + left filters ----------

function accountLabel(accountId: string | null): { username: string; provider: string } {
  const acc = cachedAccounts.find((a) => a.id === accountId);
  return { username: acc?.providerUsername ?? "Unknown", provider: acc?.provider ?? "unknown" };
}

function renderTxTableHtml(rows: Tx[], groupBy: "user" | "provider"): string {
  if (rows.length === 0) return `<div class="empty-state">No payments recorded yet.</div>`;
  return `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>${groupBy === "user" ? "Prop firm" : "Account"}</th>
          <th>Status</th>
          <th style="text-align:right">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((t) => {
            const { username, provider } = accountLabel(t.providerAccountId);
            const otherCol =
              groupBy === "user"
                ? `<span style="text-transform:capitalize">${escapeHtml(provider)}</span>`
                : `<span style="font-family:ui-monospace,'JetBrains Mono',monospace;font-size:13px">${escapeHtml(username)}</span>`;
            return `
          <tr>
            <td>${new Date(t.occurredAt).toLocaleDateString()}</td>
            <td>${otherCol}</td>
            <td>${t.status}</td>
            <td class="amount">${money(t.amountCents, t.currency)}</td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function renderPaymentsGroupedView() {
  const mainEl = document.querySelector<HTMLDivElement>("#shell-main")!;
  const filtered = cachedChargeTx.filter(
    (t) => paymentsAccountFilter === "all" || t.providerAccountId === paymentsAccountFilter
  );
  const groups = new Map<string, Tx[]>();
  for (const t of filtered) {
    const { username, provider } = accountLabel(t.providerAccountId);
    const label = paymentsGroupBy === "user" ? username : provider;
    const bucket = groups.get(label) ?? [];
    bucket.push(t);
    groups.set(label, bucket);
  }
  const groupList = Array.from(groups.entries())
    .map(([label, rows]) => ({
      label,
      rows: rows.slice().sort((a, b) => b.occurredAt - a.occurredAt),
      total: rows.reduce((s, r) => s + r.amountCents, 0),
    }))
    .sort((a, b) => b.total - a.total);

  if (groupList.length === 0) {
    mainEl.innerHTML = `<div class="card empty-state">No payments recorded yet.</div>`;
    return;
  }

  mainEl.innerHTML = `
    <h3 class="shell-main-title">Payments</h3>
    <div class="accordion" id="payments-accordion">
      ${groupList
        .map(
          (g, i) => `
        <div class="card accordion-item ${i === 0 ? "open" : ""}" data-idx="${i}">
          <button type="button" class="accordion-header" data-idx="${i}">
            <span class="accordion-label" style="text-transform:capitalize">${escapeHtml(g.label)}</span>
            <span class="accordion-meta">
              <span>${g.rows.length} record${g.rows.length === 1 ? "" : "s"}</span>
              <span class="accordion-total">${money(g.total)}</span>
              <svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </span>
          </button>
          <div class="accordion-panel" data-idx="${i}" style="${i === 0 ? "" : "display:none"}">
            ${renderTxTableHtml(
              paymentsRowsPerGroup === "all" ? g.rows : g.rows.slice(0, paymentsRowsPerGroup),
              paymentsGroupBy
            )}
          </div>
        </div>`
        )
        .join("")}
    </div>
  `;

  mainEl.querySelectorAll<HTMLButtonElement>(".accordion-header").forEach((btn) =>
    btn.addEventListener("click", () => {
      const idx = btn.dataset.idx;
      const panel = mainEl.querySelector<HTMLDivElement>(`.accordion-panel[data-idx="${idx}"]`)!;
      const item = btn.closest(".accordion-item")!;
      const isOpen = panel.style.display !== "none";
      panel.style.display = isOpen ? "none" : "";
      item.classList.toggle("open", !isOpen);
    })
  );
}

// ---------- Dashboard view (top-level nav): KPIs, charts, breakdown, sub-tabs ----------

async function loadDashboardMain(user: User) {
  const mainEl = document.querySelector<HTMLDivElement>("#shell-main")!;
  // Sequential, not Promise.all: the local single-process dev bridge
  // (dev.mjs, Node http + Miniflare) is not safe under concurrent requests on
  // one keep-alive connection; production Workers has no such constraint, but
  // going sequential here costs nothing and avoids a dev-only crash.
  const summaryRes = await api<Summary>("/api/dashboard/summary");
  const accountsRes = await api<{ accounts: Account[] }>("/api/accounts");
  const subsRes = await api<{ subscriptions: Tx[] }>("/api/dashboard/subscriptions");
  const txRes = await api<{ transactions: Tx[] }>("/api/dashboard/transactions");

  const summary = summaryRes.data;
  const accounts = accountsRes.data.accounts ?? [];
  cachedAccounts = accounts;
  const subscriptions = subsRes.data.subscriptions ?? [];
  const txs = txRes.data.transactions ?? [];

  mainEl.innerHTML = `
    <div class="kpi-row kpi-row-4">
      <div class="card kpi-card">
        <div class="kpi-top"><span class="kpi-label">Total paid (all providers)</span>${kpiIcon("paid")}</div>
        <div class="kpi-value">${money(summary.totalPaidCents ?? 0)}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-top"><span class="kpi-label">Total payouts received</span>${kpiIcon("payout")}</div>
        <div class="kpi-value">${money(summary.totalPayoutCents ?? 0)}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-top"><span class="kpi-label">Net cost</span>${kpiIcon("net")}</div>
        <div class="kpi-value">${money(summary.netCostCents ?? 0)}</div>
        <div class="kpi-subnote">Total paid minus total payouts</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-top"><span class="kpi-label">Active subscriptions / mo</span>${kpiIcon("sub")}</div>
        <div class="kpi-value">${money(summary.activeSubscriptionMonthlyCents ?? 0)}</div>
      </div>
    </div>

    <div class="card chart-card">
      <h3 class="chart-card-title">Total income vs. expenses (all providers)</h3>
      <div id="income-expense-chart"></div>
    </div>

    <div class="card breakdown-card">
      <div class="breakdown-header">
        <div class="breakdown-title">Breakdown</div>
        <div class="segmented" id="breakdown-seg">
          <button type="button" class="seg-btn ${breakdownMode === "provider" ? "active" : ""}" data-v="provider">By prop firm</button>
          <button type="button" class="seg-btn ${breakdownMode === "user" ? "active" : ""}" data-v="user">By user</button>
        </div>
      </div>
      <div id="breakdown-chart"></div>
      <div id="breakdown-table"></div>
    </div>

    <div class="card tabs-card">
      <div class="tabs-bar" id="tabs-bar">
        <button class="tab-btn ${dashboardTab === "payments" ? "active" : ""}" data-tab="payments">${tabIcon("payments")}<span>Payments</span></button>
        <button class="tab-btn ${dashboardTab === "subscriptions" ? "active" : ""}" data-tab="subscriptions">${tabIcon("subscriptions")}<span>Subscriptions</span></button>
        <button class="tab-btn ${dashboardTab === "payouts" ? "active" : ""}" data-tab="payouts">${tabIcon("payouts")}<span>Payouts</span></button>
        <button class="tab-btn ${dashboardTab === "accounts" ? "active" : ""}" data-tab="accounts">${tabIcon("accounts")}<span>Accounts</span></button>
        <button class="tab-btn ${dashboardTab === "users" ? "active" : ""}" data-tab="users">${tabIcon("users")}<span>Users</span></button>
      </div>

      <div class="tab-panel" data-panel="payments" style="${dashboardTab === "payments" ? "" : "display:none"}">
        <div class="filter-row">
          <select id="payments-filter-provider">
            <option value="">All prop firms</option>
            <option value="tradeify">Tradeify</option>
            <option value="bulenox">Bulenox</option>
          </select>
        </div>
        <div class="table-scroll" id="payments-container"></div>
      </div>

      <div class="tab-panel" data-panel="subscriptions" style="${dashboardTab === "subscriptions" ? "" : "display:none"}">
        <div class="hint-text" style="margin:0 0 12px">${summary.subscriptions?.active ?? 0} active · ${
          summary.subscriptions?.cancelled ?? 0
        } cancelled/failed</div>
        <div class="table-scroll" id="subs-container"></div>
      </div>

      <div class="tab-panel" data-panel="payouts" style="${dashboardTab === "payouts" ? "" : "display:none"}">
        <div class="filter-row">
          <select id="payouts-filter-provider">
            <option value="">All prop firms</option>
            <option value="tradeify">Tradeify</option>
            <option value="bulenox">Bulenox</option>
          </select>
        </div>
        <div class="table-scroll" id="payouts-container"></div>
      </div>

      <div class="tab-panel" data-panel="accounts" style="${dashboardTab === "accounts" ? "" : "display:none"}">
        <div class="accounts-toolbar">
          <div class="page-size-row">
            <label for="accounts-page-size">Show</label>
            <select id="accounts-page-size">
              ${PAGE_SIZE_OPTIONS.map((n) => `<option value="${n}" ${n === accountsPageSize ? "selected" : ""}>${n}</option>`).join("")}
            </select>
            <span>entries</span>
          </div>
          <button class="primary" id="add-account-btn">+ Connect account</button>
        </div>
        <div id="accounts-container"></div>
        <div class="pager-row" id="accounts-pager"></div>
      </div>

      <div class="tab-panel" data-panel="users" style="${dashboardTab === "users" ? "" : "display:none"}">
        <div class="hint-text" style="margin:0 0 12px">Uncheck a user to keep pulling and storing their data as usual, while excluding it from the KPI totals and breakdown above.</div>
        <div class="table-scroll" id="users-container"></div>
      </div>
    </div>

    <div class="dual-chart-grid">
      <div class="card">
        <h3 class="chart-card-title">Paid vs. payouts by prop firm</h3>
        <div id="paid-payouts-provider-chart"></div>
      </div>
      <div class="card">
        <h3 class="chart-card-title">Paid vs. payouts by user</h3>
        <div id="paid-payouts-user-chart"></div>
      </div>
    </div>
  `;

  renderIncomeExpenseChart(summary, "#income-expense-chart");
  renderBreakdown(summary, breakdownMode, "#breakdown-chart", "#breakdown-table");
  renderPaidPayoutsChart(summary, "provider", "#paid-payouts-provider-chart");
  renderPaidPayoutsChart(summary, "user", "#paid-payouts-user-chart");

  renderAccounts(accounts);
  renderSubscriptions(subscriptions);
  renderTransactions(txs.filter((t) => t.kind === "charge"), "#payments-container");
  renderTransactions(txs.filter((t) => t.kind === "payout"), "#payouts-container");
  renderUsersTab(accounts, summary);

  document.querySelectorAll<HTMLButtonElement>("#breakdown-seg .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      breakdownMode = btn.dataset.v as "provider" | "user";
      document.querySelectorAll("#breakdown-seg .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderBreakdown(summary, breakdownMode, "#breakdown-chart", "#breakdown-table");
    })
  );

  document.querySelectorAll<HTMLButtonElement>("#tabs-bar .tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      dashboardTab = btn.dataset.tab as typeof dashboardTab;
      document.querySelectorAll("#tabs-bar .tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll<HTMLDivElement>(".tab-panel").forEach((p) => {
        p.style.display = p.dataset.panel === dashboardTab ? "" : "none";
      });
    })
  );

  document.querySelector("#add-account-btn")?.addEventListener("click", () => openAddAccountModal(user));
  document.querySelector<HTMLSelectElement>("#accounts-page-size")?.addEventListener("change", (e) => {
    accountsPageSize = Number((e.target as HTMLSelectElement).value) as (typeof PAGE_SIZE_OPTIONS)[number];
    accountsPage = 0;
    renderAccounts(accounts);
  });

  const applyPaymentsFilter = async () => {
    const provider = (document.querySelector<HTMLSelectElement>("#payments-filter-provider")!).value;
    const params = new URLSearchParams({ kind: "charge" });
    if (provider) params.set("provider", provider);
    const res = await api<{ transactions: Tx[] }>(`/api/dashboard/transactions?${params.toString()}`);
    renderTransactions(res.data.transactions ?? [], "#payments-container");
  };
  document.querySelector("#payments-filter-provider")?.addEventListener("change", applyPaymentsFilter);

  const applyPayoutsFilter = async () => {
    const provider = (document.querySelector<HTMLSelectElement>("#payouts-filter-provider")!).value;
    const params = new URLSearchParams({ kind: "payout" });
    if (provider) params.set("provider", provider);
    const res = await api<{ transactions: Tx[] }>(`/api/dashboard/transactions?${params.toString()}`);
    renderTransactions(res.data.transactions ?? [], "#payouts-container");
  };
  document.querySelector("#payouts-filter-provider")?.addEventListener("change", applyPayoutsFilter);
}

// ---------- accounts / subscriptions / transactions / modal (unchanged behavior) ----------

function refreshBadge(status: string | null, message: string | null): string {
  if (!status) return "";
  const label = { pending: "Queued", running: "Refreshing…", done: "Refreshed", failed: "Failed" }[status] ?? status;
  const cls = status === "failed" ? "failed" : status === "done" ? "done" : "pending";
  const title = message ? ` title="${escapeHtml(message)}"` : "";
  return `<span class="refresh-badge ${cls}"${title}>${label}</span>`;
}

function renderAccounts(accounts: Account[]) {
  const el = document.querySelector<HTMLDivElement>("#accounts-container")!;
  const pagerEl = document.querySelector<HTMLDivElement>("#accounts-pager")!;
  if (accounts.length === 0) {
    el.innerHTML = `<div class="card empty-state">Connect your first prop-firm account to see numbers here.</div>`;
    pagerEl.innerHTML = "";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(accounts.length / accountsPageSize));
  if (accountsPage >= totalPages) accountsPage = totalPages - 1;
  if (accountsPage < 0) accountsPage = 0;
  const start = accountsPage * accountsPageSize;
  const pageItems = accounts.slice(start, start + accountsPageSize);

  el.innerHTML = `<div class="accounts-grid">${pageItems
    .map(
      (a) => `
      <div class="card account-card" data-id="${a.id}">
        <div class="account-provider-row">
          <div class="account-provider">${a.provider}</div>
          ${refreshBadge(a.lastRefreshStatus, a.lastRefreshMessage)}
        </div>
        <div class="account-username">${escapeHtml(a.providerUsername)}</div>
        <div class="account-status">Account since: ${fmtDate(a.providerSince)}</div>
        <div class="account-status">Last refreshed: ${fmtDate(a.lastRefreshedAt)}${a.active ? "" : " · inactive (excluded from totals)"}</div>
        ${
          a.lastRefreshStatus === "failed" && a.lastRefreshMessage
            ? `<div class="error-text">${escapeHtml(a.lastRefreshMessage)}</div>`
            : ""
        }
        <div class="account-actions">
          <button class="refresh-btn" data-id="${a.id}">Refresh</button>
          <button class="toggle-btn" data-id="${a.id}" data-active="${a.active}">${a.active ? "Deactivate" : "Activate"}</button>
          <button class="danger delete-btn" data-id="${a.id}">Delete</button>
        </div>
      </div>`
    )
    .join("")}</div>`;

  pagerEl.innerHTML = `
    <span class="pager-info">Showing ${start + 1}-${Math.min(start + accountsPageSize, accounts.length)} of ${accounts.length}</span>
    <div class="pager-buttons">
      <button class="ghost" id="accounts-prev-page" ${accountsPage === 0 ? "disabled" : ""}>‹ Prev</button>
      <button class="ghost" id="accounts-next-page" ${accountsPage >= totalPages - 1 ? "disabled" : ""}>Next ›</button>
    </div>
  `;
  pagerEl.querySelector("#accounts-prev-page")?.addEventListener("click", () => {
    accountsPage -= 1;
    renderAccounts(accounts);
  });
  pagerEl.querySelector("#accounts-next-page")?.addEventListener("click", () => {
    accountsPage += 1;
    renderAccounts(accounts);
  });

  el.querySelectorAll<HTMLButtonElement>(".refresh-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Queuing…";
      await api(`/api/accounts/${btn.dataset.id}/refresh`, { method: "POST" });
      btn.textContent = "Queued";
    })
  );
  el.querySelectorAll<HTMLButtonElement>(".toggle-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const active = btn.dataset.active === "1";
      await api(`/api/accounts/${btn.dataset.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !active }),
      });
      const me = await api<{ user: User }>("/api/auth/me");
      if (me.data.user) loadDashboardMain(me.data.user);
    })
  );
  el.querySelectorAll<HTMLButtonElement>(".delete-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this account and its stored login? This cannot be undone.")) return;
      await api(`/api/accounts/${btn.dataset.id}`, { method: "DELETE" });
      const me = await api<{ user: User }>("/api/auth/me");
      if (me.data.user) loadDashboardMain(me.data.user);
    })
  );
}

function renderUsersTab(accounts: Account[], summary: Summary) {
  const el = document.querySelector<HTMLDivElement>("#users-container")!;
  if (accounts.length === 0) {
    el.innerHTML = `<div class="empty-state">No users recorded yet — connect a prop-firm account to see it here.</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Prop firm</th>
          <th>User</th>
          <th style="text-align:right">Total paid</th>
          <th style="text-align:right">Total payouts</th>
          <th style="text-align:right">Net cost</th>
          <th>Last updated</th>
          <th>Counts in totals</th>
          <th>Refresh</th>
        </tr>
      </thead>
      <tbody>
        ${accounts
          .map((a) => {
            const b = summary.byUser[a.providerUsername];
            return `
          <tr data-id="${a.id}">
            <td style="text-transform:capitalize">${escapeHtml(a.provider)}</td>
            <td style="font-family:ui-monospace,'JetBrains Mono',monospace;font-size:13px">${escapeHtml(a.providerUsername)}</td>
            <td class="amount">${money(b?.totalPaidCents ?? 0)}</td>
            <td class="amount">${money(b?.totalPayoutCents ?? 0)}</td>
            <td class="amount">${money(b?.netCostCents ?? 0)}</td>
            <td>${fmtDate(a.lastRefreshedAt)}</td>
            <td><input type="checkbox" class="users-active-toggle" data-id="${a.id}" ${a.active ? "checked" : ""}></td>
            <td><button class="refresh-btn" data-id="${a.id}">Refresh</button></td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll<HTMLInputElement>(".users-active-toggle").forEach((cb) =>
    cb.addEventListener("change", async () => {
      await api(`/api/accounts/${cb.dataset.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: cb.checked }),
      });
      const me = await api<{ user: User }>("/api/auth/me");
      if (me.data.user) loadDashboardMain(me.data.user);
    })
  );
  el.querySelectorAll<HTMLButtonElement>(".refresh-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Queuing…";
      await api(`/api/accounts/${btn.dataset.id}/refresh`, { method: "POST" });
      btn.textContent = "Queued";
    })
  );
}

function renderSubscriptions(subs: Tx[]) {
  const el = document.querySelector<HTMLDivElement>("#subs-container")!;
  if (subs.length === 0) {
    el.innerHTML = `<div class="empty-state">No subscriptions found yet — they will appear once a Tradeify account is refreshed.</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr><th>Prop firm</th><th>Since</th><th>Status</th><th style="text-align:right">Amount</th></tr>
      </thead>
      <tbody>
        ${subs
          .map(
            (s) => `
          <tr>
            <td style="text-transform:capitalize">${s.provider}</td>
            <td>${new Date(s.occurredAt).toLocaleDateString()}</td>
            <td><span class="refresh-badge ${s.status === "successful" ? "done" : "failed"}">${
              s.status === "successful" ? "Active" : "Cancelled/failed"
            }</span></td>
            <td class="amount">${money(s.amountCents, s.currency)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderTransactions(txs: Tx[], targetSelector = "#tx-container") {
  const el = document.querySelector<HTMLDivElement>(targetSelector)!;
  if (txs.length === 0) {
    el.innerHTML = `<div class="empty-state">No transactions yet — they will appear once a connected account is refreshed.</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr><th>Date</th><th>Provider</th><th>Kind</th><th>Status</th><th style="text-align:right">Amount</th></tr>
      </thead>
      <tbody>
        ${txs
          .map(
            (t) => `
          <tr>
            <td>${new Date(t.occurredAt).toLocaleDateString()}</td>
            <td style="text-transform:capitalize">${t.provider}</td>
            <td>${t.kind}</td>
            <td>${t.status}</td>
            <td class="amount">${money(t.amountCents, t.currency)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function openAddAccountModal(user: User) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h3>Connect a prop-firm account</h3>
      <form id="add-account-form">
        <div class="field">
          <label>Prop firm</label>
          <select id="provider">
            <option value="tradeify">Tradeify</option>
            <option value="bulenox">Bulenox</option>
          </select>
        </div>
        <div class="field">
          <label>Login (email/username)</label>
          <input id="acc-username" required />
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" id="acc-password" required />
        </div>
        <div class="error-text" id="add-account-error" style="display:none"></div>
        <div class="modal-actions">
          <button type="button" class="ghost" id="cancel-btn">Cancel</button>
          <button type="submit" class="primary">Connect</button>
        </div>
      </form>
    </div>
  `;
  document.body.append(overlay);
  overlay.querySelector("#cancel-btn")?.addEventListener("click", () => overlay.remove());
  overlay.querySelector("#add-account-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const provider = (overlay.querySelector<HTMLSelectElement>("#provider")!).value;
    const username = (overlay.querySelector<HTMLInputElement>("#acc-username")!).value;
    const password = (overlay.querySelector<HTMLInputElement>("#acc-password")!).value;
    const res = await api<{ error?: string }>("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ provider, username, password }),
    });
    if (!res.ok) {
      const errEl = overlay.querySelector<HTMLDivElement>("#add-account-error")!;
      errEl.textContent = res.data.error ?? "Could not connect this account";
      errEl.style.display = "block";
      return;
    }
    overlay.remove();
    loadDashboardMain(user);
  });
}

void boot();
