import React, { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";

type Location = { id: string; name: string };
type RangeKey = "today" | "7d" | "30d";
type DashboardMetricKey = "leadsInTool" | "messagesSent" | "aiChatsStarted" | "repliesReceived";

type DashboardOverview = {
  range: RangeKey;
  startAt: string;
  endAt: string;
  locationId?: string | null;
  kpis: {
    leadsInTool: { current: number; previous: number; total: number; deltaPct: number };
    messagesSent: { current: number; previous: number; deltaPct: number };
    aiChatsStarted: { current: number; previous: number; deltaPct: number };
    repliesReceived: { current: number; previous: number; deltaPct: number };
  };
  funnel: {
    leadsInTool: number;
    aiStarted: number;
    reactions: number;
    salesHandover: number;
    reviewNeeded: number;
  };
  performance: {
    conversionRate: number;
    avgResponseMinutes?: number | null;
  };
  activeRequests: Array<{
    id: string;
    type: "sales_handover" | "review_needed";
    leadName: string;
    leadPhone?: string | null;
    reason: string;
    createdAt: string;
  }>;
  debug?: {
    enrollmentsScanned: number;
    sessionsScanned: number;
    eventsScanned: number;
    stepsScanned: number;
    agentRunsScanned?: number;
  };
};

type DashboardDrilldown = {
  metric: DashboardMetricKey;
  range: RangeKey;
  locationId?: string | null;
  from: string;
  to: string;
  count: number;
  items: Array<{
    id: string;
    createdAt: string;
    title: string;
    subtitle?: string;
    detail?: string;
    source: string;
    channel?: string;
    payload?: Record<string, unknown> | null;
  }>;
};

type StatTone = "blue" | "green" | "orange" | "attention";
type FunnelTone = "blue" | "green" | "orange" | "attention";

const periodLabel: Record<RangeKey, string> = {
  today: "Vandaag",
  "7d": "Laatste 7 dagen",
  "30d": "Laatste 30 dagen",
};

const formatDelta = (value: number) => {
  if (!Number.isFinite(value)) return "0%";
  const rounded = Math.round(value);
  if (rounded > 0) return `+${rounded}%`;
  return `${rounded}%`;
};

const formatMinutes = (value?: number | null) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value < 1) return "< 1 min";
  return `${Math.round(value)} min`;
};

const formatRelativeTime = (value: string) => {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "Onbekend";
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return "Zojuist";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} min geleden`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}u geleden`;
  const days = Math.floor(hours / 24);
  return `${days}d geleden`;
};

const formatDateTime = (value: string) => {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  return new Date(ts).toLocaleString("nl-BE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const StatCard: React.FC<{
  metricKey: DashboardMetricKey;
  title: string;
  value: string | number;
  helper: string;
  trend?: string;
  tone: StatTone;
  icon: React.ReactNode;
  onClick: (metric: DashboardMetricKey) => void;
}> = ({ metricKey, title, value, helper, trend, tone, icon, onClick }) => {
  return (
    <button
      type="button"
      className="dashboard-v2-stat dashboard-v2-stat--clickable"
      onClick={() => onClick(metricKey)}
    >
      <div className="dashboard-v2-stat__top">
        <div>
          <p>{title}</p>
          <strong>{value}</strong>
        </div>
        <span className={`dashboard-v2-stat__icon dashboard-v2-stat__icon--${tone}`}>{icon}</span>
      </div>
      <div className="dashboard-v2-stat__bottom">
        {trend ? <span className={`dashboard-v2-trend dashboard-v2-trend--${tone}`}>{trend}</span> : null}
        <small>{helper}</small>
      </div>
    </button>
  );
};

const FunnelBar: React.FC<{
  label: string;
  value: number;
  width: string;
  tone: FunnelTone;
}> = ({ label, value, width, tone }) => {
  return (
    <div className="dashboard-v2-funnel__row">
      <span>{label}</span>
      <div className="dashboard-v2-funnel__track">
        <div className={`dashboard-v2-funnel__fill dashboard-v2-funnel__fill--${tone}`} style={{ width }} />
      </div>
      <strong>{value}</strong>
    </div>
  );
};

const ActivityList: React.FC<{
  items: DashboardOverview["activeRequests"];
}> = ({ items }) => {
  return (
    <section className="panel panel--leads dashboard-v2-sidecard">
      <header className="panel__header dashboard-v2-sidecard__header">
        <h2>Active requests</h2>
      </header>
      <div className="panel__body dashboard-v2-sidecard__body">
        {items.length === 0 ? <p className="dashboard-v2-empty">Geen actieve requests in deze periode.</p> : null}
        {items.map((item) => (
          <article key={item.id} className="dashboard-v2-request">
            <div className="dashboard-v2-request__top">
              <strong>{item.leadName}</strong>
              <span
                className={`dashboard-v2-request__badge ${
                  item.type === "sales_handover"
                    ? "dashboard-v2-request__badge--sales"
                    : "dashboard-v2-request__badge--review"
                }`}
              >
                {item.type === "sales_handover" ? "Sales overdracht" : "Review nodig"}
              </span>
            </div>
            <p>{item.reason}</p>
            <div className="dashboard-v2-request__meta">
              <span>{item.leadPhone?.trim() || "Geen nummer"}</span>
              <span>{formatRelativeTime(item.createdAt)}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

const DrilldownModal: React.FC<{
  open: boolean;
  metric: DashboardMetricKey | null;
  data: DashboardDrilldown | null;
  loading: boolean;
  error?: string | null;
  onClose: () => void;
  onRefresh: () => void;
}> = ({ open, metric, data, loading, error, onClose, onRefresh }) => {
  if (!open || !metric) return null;
  const titleMap: Record<DashboardMetricKey, string> = {
    leadsInTool: "Leads in tool",
    messagesSent: "Berichten verzonden",
    aiChatsStarted: "AI chats gestart",
    repliesReceived: "Reacties ontvangen",
  };
  return (
    <div className="dashboard-drilldown" role="dialog" aria-modal="true">
      <div className="dashboard-drilldown__backdrop" onClick={onClose} />
      <div className="dashboard-drilldown__panel">
        <header className="dashboard-drilldown__header">
          <div>
            <h3>{titleMap[metric]} details</h3>
            <p>
              {data?.count ?? 0} records in {data ? periodLabel[data.range] : periodLabel["7d"]}
            </p>
          </div>
          <div className="dashboard-drilldown__actions">
            <button className="button button--ghost" onClick={onRefresh} disabled={loading}>
              {loading ? "Laden..." : "Vernieuwen"}
            </button>
            <button className="button button--ghost" onClick={onClose}>
              Sluiten
            </button>
          </div>
        </header>

        {error ? <div className="alert alert--error">{error}</div> : null}
        {loading ? <div className="alert alert--note">Detaildata laden...</div> : null}

        <div className="dashboard-drilldown__list">
          {(data?.items ?? []).map((item) => (
            <article key={`${item.source}-${item.id}`} className="dashboard-drilldown__item">
              <div className="dashboard-drilldown__item-head">
                <strong>{item.title}</strong>
                <span>{formatDateTime(item.createdAt)}</span>
              </div>
              {item.subtitle ? <p>{item.subtitle}</p> : null}
              {item.detail ? <p>{item.detail}</p> : null}
              <div className="dashboard-drilldown__meta">
                <span>Bron: {item.source}</span>
                {item.channel ? <span>Kanaal: {item.channel}</span> : null}
              </div>
              {item.payload ? (
                <details className="dashboard-drilldown__payload">
                  <summary>Ruwe payload</summary>
                  <pre>{JSON.stringify(item.payload, null, 2)}</pre>
                </details>
              ) : null}
            </article>
          ))}
          {!loading && (data?.items?.length ?? 0) === 0 ? (
            <p className="dashboard-v2-empty">Geen records gevonden voor deze metric in de gekozen periode.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const Dashboard: React.FC = () => {
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("7d");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [activeMetric, setActiveMetric] = useState<DashboardMetricKey | null>(null);
  const [drilldown, setDrilldown] = useState<DashboardDrilldown | null>(null);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState<string | null>(null);

  const subaccountOptions = useMemo(() => {
    const preferred = ["Vastgoed", "Dakwerken", "Gevelwerken"];
    const filtered = locations.filter((loc) => preferred.includes(loc.name));
    return filtered.length ? filtered : locations;
  }, [locations]);

  const loadLocations = async () => {
    const response = await fetch("/api/locations");
    const data = await response.json().catch(() => ({}));
    setLocations(data.locations ?? []);
  };

  const loadOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("range", range);
      if (selectedLocationId) params.set("locationId", selectedLocationId);
      const response = await fetch(`/api/dashboard/overview?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as DashboardOverview | { error?: string };
      if (!response.ok) {
        throw new Error((data as { error?: string })?.error || "Dashboard laden mislukt.");
      }
      setOverview(data as DashboardOverview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dashboard laden mislukt.");
      setOverview(null);
    } finally {
      setLoading(false);
    }
  };

  const loadDrilldown = async (metric: DashboardMetricKey) => {
    setDrilldownLoading(true);
    setDrilldownError(null);
    try {
      const params = new URLSearchParams();
      params.set("metric", metric);
      params.set("range", range);
      params.set("limit", "250");
      if (selectedLocationId) params.set("locationId", selectedLocationId);
      const response = await fetch(`/api/dashboard/drilldown?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as
        | DashboardDrilldown
        | { error?: string };
      if (!response.ok) {
        throw new Error((data as { error?: string })?.error || "Detaildata laden mislukt.");
      }
      setDrilldown(data as DashboardDrilldown);
    } catch (err) {
      setDrilldownError(err instanceof Error ? err.message : "Detaildata laden mislukt.");
      setDrilldown(null);
    } finally {
      setDrilldownLoading(false);
    }
  };

  useEffect(() => {
    void loadLocations();
  }, []);

  useEffect(() => {
    if (!selectedLocationId && subaccountOptions.length > 0) {
      setSelectedLocationId(subaccountOptions[0].id);
    }
  }, [selectedLocationId, subaccountOptions]);

  useEffect(() => {
    if (!selectedLocationId) return;
    void loadOverview();
  }, [selectedLocationId, range]);

  useEffect(() => {
    if (!activeMetric || !selectedLocationId) return;
    void loadDrilldown(activeMetric);
  }, [activeMetric, range, selectedLocationId]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveMetric(null);
      }
    };
    if (activeMetric) {
      window.addEventListener("keydown", handleEscape);
    }
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeMetric]);

  const openMetric = (metric: DashboardMetricKey) => {
    setActiveMetric(metric);
    setDrilldown(null);
    void loadDrilldown(metric);
  };

  const activeLocationName =
    subaccountOptions.find((item) => item.id === selectedLocationId)?.name ?? "Subaccount";

  const funnelMax = Math.max(
    overview?.funnel.leadsInTool ?? 0,
    overview?.funnel.aiStarted ?? 0,
    overview?.funnel.reactions ?? 0,
    overview?.funnel.salesHandover ?? 0,
    overview?.funnel.reviewNeeded ?? 0,
    1
  );
  const toPct = (value: number) => `${Math.max(0, Math.min(100, (value / funnelMax) * 100))}%`;

  return (
    <div className="ghl-shell ghl-shell--leads ghl-shell--dashboard">
      <aside className="ghl-sidebar">
        <div className="ghl-brand">
          <span className="ghl-brand__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="ghl-icon">
              <path d="M4 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm6-3h4a2 2 0 0 1 2 2v1H8V6a2 2 0 0 1 2-2z" />
            </svg>
          </span>
          <div>
            <strong>LeadPilot</strong>
            <span>Dashboard</span>
          </div>
        </div>

        <div className="ghl-account">
          <label>Subaccount</label>
          <select
            className="input"
            value={selectedLocationId ?? ""}
            onChange={(event) => setSelectedLocationId(event.target.value)}
          >
            {subaccountOptions.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </div>

        <nav className="ghl-nav">
          <NavLink
            className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`}
            to="/dashboard"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
              </svg>
            </span>
            Dashboard
          </NavLink>
          <NavLink
            className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`}
            to="/leads"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M7.5 12a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm9 0a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM3 20.5c0-3 3-5.5 6.5-5.5S16 17.5 16 20.5V22H3v-1.5zm9.5 1.5v-1.5c0-1.6-.6-3-1.6-4.1.8-.3 1.7-.4 2.6-.4 3.6 0 6.5 2.5 6.5 5.5V22h-7.5z" />
              </svg>
            </span>
            Leads
          </NavLink>
          <NavLink
            className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`}
            to="/conversations"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V7a2 2 0 0 1 2-2zm3 4h10v2H7V9zm0 4h7v2H7v-2z" />
              </svg>
            </span>
            Conversations
          </NavLink>
          <NavLink
            className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`}
            to="/ai-agents"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2zm7 9l.9 2.6L22 14l-2.1.4L19 17l-.9-2.6L16 14l2.1-.4L19 11zM5 13l.9 2.6L8 16l-2.1.4L5 19l-.9-2.6L2 16l2.1-.4L5 13z" />
              </svg>
            </span>
            AI Agents
          </NavLink>
          <NavLink
            className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`}
            to="/workflows"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M9 3h6v4h2a2 2 0 0 1 2 2v2h-4V9H9v4H5V9a2 2 0 0 1 2-2h2V3zm-4 12h4v4H7a2 2 0 0 1-2-2v-2zm6 0h4v6h-4v-6zm6 0h4v2a2 2 0 0 1-2 2h-2v-4z" />
              </svg>
            </span>
            Workflows
          </NavLink>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M7 2h2v3H7V2zm8 0h2v3h-2V2zM4 5h16a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 6h16v9H4v-9z" />
              </svg>
            </span>
            Calendar
          </button>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M4 20V4h2v16H4zm7 0V9h2v11h-2zm7 0V13h2v7h-2z" />
              </svg>
            </span>
            Analytics
          </button>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M3 6h18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm0 4h18V8H3v2zm4 6h4v2H7v-2z" />
              </svg>
            </span>
            Billing
          </button>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm8.4 4a6.4 6.4 0 0 0-.1-1l2.1-1.6-2-3.5-2.5 1a7.7 7.7 0 0 0-1.7-1l-.3-2.7h-4l-.3 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1-2 3.5L3.6 11a6.4 6.4 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.7 7.7 0 0 0 1.7 1l.3 2.7h4l.3-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1 2-3.5-2.1-1.6c.1-.3.1-.6.1-1z" />
              </svg>
            </span>
            Settings
          </button>
        </nav>
      </aside>

      <main className="ghl-main ghl-main--leads ghl-main--dashboard">
        <header className="ghl-main__header ghl-main__header--leads">
          <div>
            <h1>Dashboard</h1>
            <p>In-app overzicht voor {activeLocationName}</p>
          </div>
          <div className="header-actions">
            <a className="toggle" href="/">
              Terug naar inbox
            </a>
          </div>
        </header>

        <section className="panel panel--leads dashboard-v2-toolbar">
          <div className="dashboard-filters dashboard-filters--new">
            <div className="field">
              <label>Periode</label>
              <select
                className="input"
                value={range}
                onChange={(event) => setRange(event.target.value as RangeKey)}
              >
                <option value="today">Vandaag</option>
                <option value="7d">Laatste 7 dagen</option>
                <option value="30d">Laatste 30 dagen</option>
              </select>
            </div>
            <button className="button button--ghost" onClick={() => void loadOverview()} disabled={loading}>
              {loading ? "Laden..." : "Vernieuwen"}
            </button>
          </div>
        </section>

        {error ? <div className="alert alert--error">{error}</div> : null}

        <div className="dashboard-v2-layout">
          <div className="dashboard-v2-main">
            <section className="dashboard-v2-stats">
              <StatCard
                metricKey="leadsInTool"
                title="Leads in tool"
                value={overview?.kpis.leadsInTool.total ?? 0}
                trend={overview ? `${formatDelta(overview.kpis.leadsInTool.deltaPct)} vs vorige periode` : ""}
                helper={overview ? `${overview.kpis.leadsInTool.current} in ${periodLabel[overview.range]}` : "-"}
                tone="blue"
                onClick={openMetric}
                icon={
                  <svg viewBox="0 0 24 24" className="ghl-icon">
                    <path d="M7.5 12a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm9 0a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM3 20.5c0-3 3-5.5 6.5-5.5S16 17.5 16 20.5V22H3v-1.5zm9.5 1.5v-1.5c0-1.6-.6-3-1.6-4.1.8-.3 1.7-.4 2.6-.4 3.6 0 6.5 2.5 6.5 5.5V22h-7.5z" />
                  </svg>
                }
              />
              <StatCard
                metricKey="messagesSent"
                title="Berichten verzonden"
                value={overview?.kpis.messagesSent.current ?? 0}
                trend={overview ? `${formatDelta(overview.kpis.messagesSent.deltaPct)} vs vorige periode` : ""}
                helper="SMS + Agent berichten vanuit de tool"
                tone="green"
                onClick={openMetric}
                icon={
                  <svg viewBox="0 0 24 24" className="ghl-icon">
                    <path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V7a2 2 0 0 1 2-2zm3 4h10v2H7V9zm0 4h7v2H7v-2z" />
                  </svg>
                }
              />
              <StatCard
                metricKey="aiChatsStarted"
                title="AI chats gestart"
                value={overview?.kpis.aiChatsStarted.current ?? 0}
                trend={overview ? `${formatDelta(overview.kpis.aiChatsStarted.deltaPct)} vs vorige periode` : ""}
                helper="Eerste AI bericht verzonden"
                tone="orange"
                onClick={openMetric}
                icon={
                  <svg viewBox="0 0 24 24" className="ghl-icon">
                    <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2zm7 9l.9 2.6L22 14l-2.1.4L19 17l-.9-2.6L16 14l2.1-.4L19 11zM5 13l.9 2.6L8 16l-2.1.4L5 19l-.9-2.6L2 16l2.1-.4L5 13z" />
                  </svg>
                }
              />
              <StatCard
                metricKey="repliesReceived"
                title="Reacties ontvangen"
                value={overview?.kpis.repliesReceived.current ?? 0}
                trend={overview ? `${formatDelta(overview.kpis.repliesReceived.deltaPct)} vs vorige periode` : ""}
                helper="Unieke inkomende antwoorden"
                tone="attention"
                onClick={openMetric}
                icon={
                  <svg viewBox="0 0 24 24" className="ghl-icon">
                    <path d="M12 9v4m0 4h.01M4.9 19h14.2a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0L3.2 16a2 2 0 0 0 1.7 3z" />
                  </svg>
                }
              />
            </section>

            <section className="panel panel--leads dashboard-v2-funnel">
              <header className="panel__header dashboard-v2-funnel__header">
                <h2>Lead Funnel</h2>
              </header>
              <div className="panel__body dashboard-v2-funnel__body">
                <FunnelBar
                  label="Leads in tool"
                  value={overview?.funnel.leadsInTool ?? 0}
                  width={toPct(overview?.funnel.leadsInTool ?? 0)}
                  tone="blue"
                />
                <FunnelBar
                  label="AI gestart"
                  value={overview?.funnel.aiStarted ?? 0}
                  width={toPct(overview?.funnel.aiStarted ?? 0)}
                  tone="blue"
                />
                <FunnelBar
                  label="Reacties"
                  value={overview?.funnel.reactions ?? 0}
                  width={toPct(overview?.funnel.reactions ?? 0)}
                  tone="green"
                />
                <FunnelBar
                  label="Sales overdracht"
                  value={overview?.funnel.salesHandover ?? 0}
                  width={toPct(overview?.funnel.salesHandover ?? 0)}
                  tone="orange"
                />
                <FunnelBar
                  label="Review nodig"
                  value={overview?.funnel.reviewNeeded ?? 0}
                  width={toPct(overview?.funnel.reviewNeeded ?? 0)}
                  tone="attention"
                />

                <div className="dashboard-v2-funnel__meta">
                  <div>
                    Conversie <strong>{overview ? `${Math.round((overview.performance.conversionRate ?? 0) * 100)}%` : "-"}</strong>
                  </div>
                  <div>
                    Gem. responstijd <strong>{formatMinutes(overview?.performance.avgResponseMinutes)}</strong>
                  </div>
                </div>
              </div>
            </section>

            <section className="panel panel--leads dashboard-note">
              <div className="panel__body">
                <p>
                  Dit dashboard gebruikt enkel in-app data uit deze tool (workflow sessies/events en
                  workflow verstuurde stappen), niet live GHL tellingen.
                </p>
              </div>
            </section>
          </div>

          <aside className="dashboard-v2-side">
            <ActivityList items={overview?.activeRequests ?? []} />
            <section className="panel panel--leads dashboard-v2-sidecard">
              <header className="panel__header dashboard-v2-sidecard__header">
                <h2>Performance</h2>
              </header>
              <div className="panel__body dashboard-v2-sidecard__body">
                <div className="dashboard-v2-kv">
                  <span>Subaccount</span>
                  <strong>{activeLocationName}</strong>
                </div>
                <div className="dashboard-v2-kv">
                  <span>Periode</span>
                  <strong>{periodLabel[range]}</strong>
                </div>
                <div className="dashboard-v2-kv">
                  <span>AI gestart</span>
                  <strong>{overview?.funnel.aiStarted ?? 0}</strong>
                </div>
                <div className="dashboard-v2-kv">
                  <span>Sales overdracht</span>
                  <strong>{overview?.funnel.salesHandover ?? 0}</strong>
                </div>
                <div className="dashboard-v2-kv">
                  <span>Review nodig</span>
                  <strong>{overview?.funnel.reviewNeeded ?? 0}</strong>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </main>

      <DrilldownModal
        open={Boolean(activeMetric)}
        metric={activeMetric}
        data={drilldown}
        loading={drilldownLoading}
        error={drilldownError}
        onClose={() => setActiveMetric(null)}
        onRefresh={() => {
          if (!activeMetric) return;
          void loadDrilldown(activeMetric);
        }}
      />
    </div>
  );
};

export default Dashboard;
