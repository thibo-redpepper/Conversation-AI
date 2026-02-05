import React, { useEffect, useMemo, useState } from "react";

type KpiRow = {
  account_id: string;
  account_name: string;
  conversations_total: number;
  messages_total: number;
  inbound_total: number;
  outbound_total: number;
  drafts_total: number;
  last_message_at?: string | null;
  last_draft_at?: string | null;
};

type DailyRow = {
  account_name: string;
  day: string;
  inbound_count: number;
  outbound_count: number;
};

type DraftRow = {
  draft_id: string;
  account_name?: string | null;
  conversation_id: string;
  ai_reply?: string | null;
  model?: string | null;
  tokens?: number | null;
  cost_eur?: number | null;
  draft_created_at?: string | null;
  last_inbound_body?: string | null;
  last_inbound_time?: string | null;
};

type LostDraftRow = {
  lost_id: string;
  account_name?: string | null;
  conversation_id: string;
  message_id?: string | null;
  status?: string | null;
  reason?: string | null;
  confidence?: number | null;
  model?: string | null;
  tokens?: number | null;
  cost_eur?: number | null;
  lost_created_at?: string | null;
  last_inbound_body?: string | null;
  last_inbound_time?: string | null;
};

type UsageSummary = {
  tokensTotal: number;
  costTotal: number;
  estimated?: boolean;
};

const apiRequest = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || "Fout bij laden.");
  }
  return data as T;
};

const formatDate = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("nl-NL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatCost = (value?: number | null) => {
  if (typeof value !== "number") return "—";
  return `€${value.toFixed(4)}`;
};

const formatConfidence = (value?: number | null) => {
  if (typeof value !== "number") return "—";
  return `${Math.round(value * 100)}%`;
};

const normalizeText = (value?: string | null) =>
  (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const shouldHideDraft = (row: DraftRow) => {
  const body = normalizeText(row.last_inbound_body);
  if (!body || body === "(leeg)" || body === "leeg" || body === "empty") {
    return true;
  }
  const skipPhrases = [
    "dnd enabled by customer",
    "do not disturb",
    "do not contact",
    "opted out",
    "unsubscribe",
    "unsubscribed",
    "stop",
    "call attempted",
    "missed call",
    "incoming call",
    "call missed",
  ];
  if (skipPhrases.some((phrase) => body.includes(phrase))) {
    return true;
  }
  return false;
};

const Dashboard: React.FC = () => {
  const [kpis, setKpis] = useState<KpiRow[]>([]);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [lostDrafts, setLostDrafts] = useState<LostDraftRow[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lostError, setLostError] = useState<string | null>(null);
  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);
  const [expandedLostId, setExpandedLostId] = useState<string | null>(null);
  const [selectedBrand, setSelectedBrand] = useState<
    "all" | "VastgoedMatch" | "TestAannemer"
  >("all");
  const [selectedAccount, setSelectedAccount] = useState<string>("all");

  const brandMap: Record<"VastgoedMatch" | "TestAannemer", string[]> = {
    VastgoedMatch: ["Vastgoed"],
    TestAannemer: ["Dakwerken", "Gevelwerken"],
  };

  const allAccountNames = useMemo(() => {
    const names = new Set<string>();
    kpis.forEach((row) => {
      if (row.account_name) names.add(row.account_name);
    });
    drafts.forEach((row) => {
      if (row.account_name) names.add(row.account_name);
    });
    lostDrafts.forEach((row) => {
      if (row.account_name) names.add(row.account_name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [kpis, drafts, lostDrafts]);

  const accountOptions =
    selectedBrand === "all"
      ? allAccountNames
      : brandMap[selectedBrand] ?? [];

  useEffect(() => {
    if (selectedAccount === "all") return;
    if (!accountOptions.includes(selectedAccount)) {
      setSelectedAccount("all");
    }
  }, [accountOptions, selectedAccount]);

  const matchesBrand = (name?: string | null) => {
    if (selectedBrand === "all") return true;
    return (brandMap[selectedBrand] ?? []).includes(name ?? "");
  };

  const matchesAccount = (name?: string | null) => {
    if (selectedAccount === "all") return true;
    return name === selectedAccount;
  };

  const filteredDrafts = drafts.filter(
    (row) => matchesBrand(row.account_name) && matchesAccount(row.account_name)
  );
  const filteredLostDrafts = lostDrafts.filter(
    (row) => matchesBrand(row.account_name) && matchesAccount(row.account_name)
  );

  useEffect(() => {
    const load = async () => {
      try {
        const [kpiRes, dailyRes, draftRes, usageRes] = await Promise.all([
          apiRequest<{ data: KpiRow[] }>("/api/dashboard/kpis"),
          apiRequest<{ data: DailyRow[] }>("/api/dashboard/daily"),
          apiRequest<{ data: DraftRow[] }>("/api/dashboard/drafts"),
          apiRequest<UsageSummary>("/api/dashboard/usage"),
        ]);
        setKpis(kpiRes.data ?? []);
        setDaily(dailyRes.data ?? []);
        setDrafts(draftRes.data ?? []);
        setUsage(usageRes ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Fout bij laden.");
      }

      try {
        const lostRes = await apiRequest<{ data: LostDraftRow[] }>(
          "/api/dashboard/lost-drafts"
        );
        setLostDrafts(lostRes.data ?? []);
      } catch (err) {
        setLostError(err instanceof Error ? err.message : "Lost drafts laden mislukt.");
      }
    };
    load();
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>Convo AI Hub — Dashboard</h1>
          <p>Overzicht van drafts en conversation volumes. Drafts worden niet verzonden.</p>
        </div>
        <div className="header-actions">
          {usage ? (
            <div className="dashboard-usage">
              <div>
                <span>Totaal tokens</span>
                <strong>{usage.tokensTotal ?? 0}</strong>
              </div>
              <div>
                <span>Totaal kost</span>
                <strong>{formatCost(usage.costTotal)}</strong>
                {usage.estimated ? <em>schatting</em> : null}
              </div>
            </div>
          ) : null}
          <div className="dashboard-filters">
            <div className="location-select">
              <label>Merk</label>
              <select
                className="input"
                value={selectedBrand}
                onChange={(event) =>
                  setSelectedBrand(
                    event.target.value as "all" | "VastgoedMatch" | "TestAannemer"
                  )
                }
              >
                <option value="all">Alle merken</option>
                <option value="VastgoedMatch">VastgoedMatch</option>
                <option value="TestAannemer">TestAannemer</option>
              </select>
            </div>
            <div className="location-select">
              <label>Subaccount</label>
              <select
                className="input"
                value={selectedAccount}
                onChange={(event) => setSelectedAccount(event.target.value)}
              >
                <option value="all">Alle subaccounts</option>
                {accountOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <a className="toggle" href="/">
            Terug naar inbox
          </a>
        </div>
      </header>

      {error ? <div className="alert alert--error">{error}</div> : null}

      <section className="panel">
        <header className="panel__header">
          <h2>KPI’s per subaccount</h2>
        </header>
        <div className="panel__body">
          <div className="kpi-grid">
            {kpis.map((row) => (
              <div className="kpi-card" key={row.account_id}>
                <div className="kpi-card__title">{row.account_name}</div>
                <div className="kpi-card__meta">
                  Laatste msg: {formatDate(row.last_message_at)}
                </div>
                <div className="kpi-card__stats">
                  <div>
                    <span>Conversations</span>
                    <strong>{row.conversations_total}</strong>
                  </div>
                  <div>
                    <span>Inbound</span>
                    <strong>{row.inbound_total}</strong>
                  </div>
                  <div>
                    <span>Outbound</span>
                    <strong>{row.outbound_total}</strong>
                  </div>
                  <div>
                    <span>Drafts</span>
                    <strong>{row.drafts_total}</strong>
                  </div>
                </div>
              </div>
            ))}
            {kpis.length === 0 ? <div className="empty">Geen data.</div> : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>Laatste AI drafts (niet verzonden)</h2>
        </header>
        <div className="panel__body">
          <div className="draft-grid">
            {filteredDrafts.filter((row) => !shouldHideDraft(row)).map((row) => (
              <div
                className={`draft-card ${expandedDraftId === row.draft_id ? "draft-card--expanded" : ""}`}
                key={row.draft_id}
                onClick={() =>
                  setExpandedDraftId((prev) => (prev === row.draft_id ? null : row.draft_id))
                }
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setExpandedDraftId((prev) =>
                      prev === row.draft_id ? null : row.draft_id
                    );
                  }
                }}
              >
                <div className="draft-card__header">
                  <div>
                    <div className="draft-card__title">{row.account_name ?? "—"}</div>
                    <div className="draft-card__meta">
                      {formatDate(row.draft_created_at)}
                      {row.model ? ` • ${row.model}` : ""}
                    </div>
                  </div>
                  <div className="draft-card__cost">
                    <span>Kost</span>
                    <strong>{formatCost(row.cost_eur)}</strong>
                    <em>{row.tokens ? `${row.tokens} tokens` : "—"}</em>
                  </div>
                </div>
                <div className="draft-card__content">
                  <div className="draft-bubble draft-bubble--lead">
                    <div className="draft-bubble__label">Lead</div>
                    <div className="draft-bubble__text">
                      {row.last_inbound_body ?? "Geen inbound bericht gevonden."}
                    </div>
                  </div>
                  <div className="draft-bubble draft-bubble--ai">
                    <div className="draft-bubble__label">AI antwoord (draft)</div>
                    <div className="draft-bubble__text">
                      {row.ai_reply ?? "Geen draft beschikbaar."}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {filteredDrafts.length === 0 ? (
              <div className="empty">Geen data.</div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>Lost drafts (test)</h2>
        </header>
        <div className="panel__body">
          {lostError ? <div className="alert alert--error">{lostError}</div> : null}
          <div className="draft-grid">
            {filteredLostDrafts.map((row) => (
              <div
                className={`draft-card ${expandedLostId === row.lost_id ? "draft-card--expanded" : ""}`}
                key={row.lost_id}
                onClick={() =>
                  setExpandedLostId((prev) => (prev === row.lost_id ? null : row.lost_id))
                }
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setExpandedLostId((prev) => (prev === row.lost_id ? null : row.lost_id));
                  }
                }}
              >
                <div className="draft-card__header">
                  <div>
                    <div className="draft-card__title">{row.account_name ?? "—"}</div>
                    <div className="draft-card__meta">
                      {formatDate(row.lost_created_at)}
                      {row.model ? ` • ${row.model}` : ""}
                      {row.status ? ` • ${row.status}` : ""}
                    </div>
                  </div>
                  <div className="draft-card__cost">
                    <span>Confidence</span>
                    <strong>{formatConfidence(row.confidence)}</strong>
                    <em>{row.tokens ? `${row.tokens} tokens` : "—"}</em>
                  </div>
                </div>
                <div className="draft-card__content">
                  <div className="draft-bubble draft-bubble--lead">
                    <div className="draft-bubble__label">Lead</div>
                    <div className="draft-bubble__text">
                      {row.last_inbound_body ?? "Geen inbound bericht gevonden."}
                    </div>
                  </div>
                  <div className="draft-bubble draft-bubble--lost">
                    <div className="draft-bubble__label">Lost draft</div>
                    <div className="draft-bubble__text">
                      {row.reason ?? "Geen reden meegegeven."}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {filteredLostDrafts.length === 0 ? (
              <div className="empty">Geen data.</div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>Dagvolume (inbound/outbound)</h2>
        </header>
        <div className="panel__body">
          <div className="table">
            <div className="table__row table__head">
              <div>Account</div>
              <div>Dag</div>
              <div>Inbound</div>
              <div>Outbound</div>
            </div>
            {daily.map((row, idx) => (
              <div className="table__row" key={`${row.account_name}-${row.day}-${idx}`}>
                <div>{row.account_name}</div>
                <div>{row.day ? row.day.slice(0, 10) : "—"}</div>
                <div>{row.inbound_count}</div>
                <div>{row.outbound_count}</div>
              </div>
            ))}
            {daily.length === 0 ? <div className="empty">Geen data.</div> : null}
          </div>
        </div>
      </section>
    </div>
  );
};

export default Dashboard;
