import React, { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";

type Location = { id: string; name: string };

type LeadRow = {
  id: string;
  name?: string;
  status?: string;
  contactId?: string;
  pipelineStageName?: string;
  createdAt?: string;
  updatedAt?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  postalCode?: string;
  city?: string;
  source?: string;
  dateAdded?: string;
};

type LeadsResponse = {
  opportunities: LeadRow[];
  searchAfter?: string;
};

type OpportunityStatsResponse = {
  total: number;
  byStage: Record<string, number>;
  cachedAt: string;
  partial: boolean;
};

type StageListResponse = {
  stages?: string[];
  error?: string;
};

type ContactDetails = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  source?: string;
  dateAdded?: string;
  dateUpdated?: string;
  tags?: string[];
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  timezone?: string;
  dnd?: boolean;
  raw?: Record<string, unknown>;
};

type ContactDetailsResponse = {
  contact?: ContactDetails;
  error?: string;
};

const NO_STAGE_LABEL = "Geen stage";

const toName = (lead: LeadRow) =>
  lead.contactName?.trim() ||
  lead.contactEmail?.split("@")[0] ||
  lead.contactPhone ||
  lead.name ||
  "Onbekend";

const toStageLabel = (value?: string) => value?.trim() || NO_STAGE_LABEL;
const isRealGhlStage = (value: string) => {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "nieuw" && normalized !== NO_STAGE_LABEL.toLowerCase();
};

const toLabel = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());

const normalizeKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const hasValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
};

const formatUnknownValue = (value: unknown) => {
  if (typeof value === "string") return value.trim() || "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Ja" : "Nee";
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    const simple = value.every(
      (item) =>
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
    );
    if (simple) {
      return value
        .map((item) => (typeof item === "boolean" ? (item ? "Ja" : "Nee") : String(item)))
        .join(", ");
    }
  }
  if (typeof value === "object" && value) {
    const text = JSON.stringify(value);
    if (!text) return "—";
    return text.length > 220 ? `${text.slice(0, 217)}...` : text;
  }
  return "—";
};

const timeAgo = (value?: string) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Net binnen";
  if (minutes < 60) return `${minutes} min geleden`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} uur geleden`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} dagen geleden`;
  return date.toLocaleDateString("nl-BE", {
    day: "2-digit",
    month: "short",
  });
};

const formatDateTime = (value?: string) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("nl-BE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatSyncTime = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("nl-BE", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

const stagePillClass = (value?: string) => {
  const lower = value?.toLowerCase() ?? "";
  if (lower.includes("active") || lower.includes("actief")) {
    return "ghl-pill ghl-pill--status ghl-pill--status-active";
  }
  if (lower.includes("review")) {
    return "ghl-pill ghl-pill--status ghl-pill--status-review";
  }
  if (
    lower.includes("afspraak") ||
    lower.includes("gepland") ||
    lower.includes("qualified") ||
    lower.includes("gekwalificeerd") ||
    lower.includes("booked") ||
    lower.includes("won")
  ) {
    return "ghl-pill ghl-pill--status ghl-pill--status-qualified";
  }
  if (lower.includes("sales")) {
    return "ghl-pill ghl-pill--status ghl-pill--status-sales";
  }
  if (lower.includes("nurture")) {
    return "ghl-pill ghl-pill--status ghl-pill--status-nurture";
  }
  if (lower.includes("lost")) {
    return "ghl-pill ghl-pill--status ghl-pill--status-lost";
  }
  return "ghl-pill ghl-pill--status";
};

const GhlLeads: React.FC = () => {
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [availableStages, setAvailableStages] = useState<string[]>([]);
  const [searchAfter, setSearchAfter] = useState<string | undefined>(undefined);
  const [stageFilter, setStageFilter] = useState("all");
  const [stats, setStats] = useState<OpportunityStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLead, setSelectedLead] = useState<LeadRow | null>(null);
  const [selectedContact, setSelectedContact] = useState<ContactDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsRefreshToken, setDetailsRefreshToken] = useState(0);

  const loadLocations = async () => {
    const response = await fetch("/api/locations");
    const data = await response.json().catch(() => ({}));
    setLocations(data.locations ?? []);
  };

  const fetchStages = async () => {
    if (!selectedLocationId) return;
    try {
      const params = new URLSearchParams();
      params.set("locationId", selectedLocationId);
      const response = await fetch(`/api/ghl/stages?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as StageListResponse;
      if (!response.ok) {
        throw new Error(data.error || "Stages ophalen mislukt.");
      }
      const next =
        data.stages
          ?.map((stage) => stage.trim())
          .filter((stage) => isRealGhlStage(stage)) ?? [];
      setAvailableStages(Array.from(new Set(next)).sort((a, b) => a.localeCompare(b, "nl-BE")));
    } catch {
      setAvailableStages([]);
    }
  };

  useEffect(() => {
    loadLocations();
  }, []);

  const subaccountOptions = useMemo(() => {
    const preferred = ["Vastgoed", "Dakwerken", "Gevelwerken"];
    const filtered = locations.filter((loc) => preferred.includes(loc.name));
    return filtered.length ? filtered : locations;
  }, [locations]);

  useEffect(() => {
    if (!selectedLocationId && subaccountOptions.length > 0) {
      setSelectedLocationId(subaccountOptions[0].id);
    }
  }, [selectedLocationId, subaccountOptions]);

  const fetchLeads = async (
    mode: "reset" | "more",
    options?: { force?: boolean; skipStats?: boolean }
  ) => {
    if (!selectedLocationId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("locationId", selectedLocationId);
      const q = query.trim();
      if (q) {
        params.set("q", q);
      }
      if (mode === "more" && searchAfter) {
        params.set("searchAfter", searchAfter);
      }
      if (stageFilter !== "all") {
        params.set("stage", stageFilter);
      }
      if (options?.force) {
        params.set("_ts", Date.now().toString());
      }
      const response = await fetch(`/api/ghl/opportunities?${params.toString()}`, {
        cache: options?.force ? "no-store" : "default",
      });
      const data = (await response.json().catch(() => ({}))) as LeadsResponse;
      if (!response.ok) {
        throw new Error((data as { error?: string }).error || "Leads ophalen mislukt.");
      }
      setLeads((prev) => {
        const next =
          mode === "more"
            ? [...prev, ...(data.opportunities ?? [])]
            : data.opportunities ?? [];
        next.sort((a, b) => {
          const aTime =
            Date.parse(a.updatedAt ?? "") ||
            Date.parse(a.createdAt ?? "") ||
            Date.parse(a.dateAdded ?? "") ||
            0;
          const bTime =
            Date.parse(b.updatedAt ?? "") ||
            Date.parse(b.createdAt ?? "") ||
            Date.parse(b.dateAdded ?? "") ||
            0;
          return bTime - aTime;
        });
        return next;
      });
      setSearchAfter(data.searchAfter);
      if (mode === "reset") {
        setLastSyncedAt(new Date().toISOString());
        if (!options?.skipStats) {
          void fetchLeadStats(options?.force ? { force: true } : undefined);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Leads ophalen mislukt.");
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    if (!selectedLocationId || syncing) return;
    setSyncing(true);
    try {
      await fetchLeads("reset", { force: true });
    } finally {
      setSyncing(false);
    }
  };

  const fetchLeadStats = async (options?: { force?: boolean }) => {
    if (!selectedLocationId) return;
    setStatsLoading(true);
    setStatsError(null);
    try {
      const params = new URLSearchParams();
      params.set("locationId", selectedLocationId);
      const q = query.trim();
      if (q) {
        params.set("q", q);
      }
      if (options?.force) {
        params.set("force", "true");
      }
      const response = await fetch(`/api/ghl/opportunities/stats?${params.toString()}`, {
        cache: options?.force ? "no-store" : "default",
      });
      const data = (await response.json().catch(() => ({}))) as
        | OpportunityStatsResponse
        | { error?: string };
      if (!response.ok) {
        throw new Error((data as { error?: string }).error || "Lead aantallen ophalen mislukt.");
      }
      setStats(data as OpportunityStatsResponse);
    } catch (err) {
      setStats(null);
      setStatsError(
        err instanceof Error ? err.message : "Lead aantallen ophalen mislukt."
      );
    } finally {
      setStatsLoading(false);
    }
  };

  useEffect(() => {
    if (selectedLocationId) {
      fetchLeads("reset", { skipStats: true });
      fetchLeadStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocationId, stageFilter]);

  useEffect(() => {
    if (selectedLocationId) {
      fetchStages();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocationId]);

  useEffect(() => {
    setSelectedLead(null);
    setSelectedContact(null);
    setDetailsError(null);
    setDetailsLoading(false);
    setStats(null);
    setStatsError(null);
    setAvailableStages([]);
  }, [selectedLocationId]);

  useEffect(() => {
    if (!selectedLead) return;

    if (!selectedLead.contactId || !selectedLocationId) {
      setSelectedContact(null);
      setDetailsError(null);
      setDetailsLoading(false);
      return;
    }

    const controller = new AbortController();
    const loadDetails = async () => {
      setDetailsLoading(true);
      setDetailsError(null);
      try {
        const params = new URLSearchParams();
        params.set("locationId", selectedLocationId);
        const response = await fetch(
          `/api/contacts/${selectedLead.contactId}?${params.toString()}`,
          { signal: controller.signal }
        );
        const data = (await response.json().catch(() => ({}))) as ContactDetailsResponse;
        if (!response.ok) {
          throw new Error(data.error || "Lead details ophalen mislukt.");
        }
        setSelectedContact(data.contact ?? null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setSelectedContact(null);
        setDetailsError(
          err instanceof Error ? err.message : "Lead details ophalen mislukt."
        );
      } finally {
        if (!controller.signal.aborted) {
          setDetailsLoading(false);
        }
      }
    };

    loadDetails();
    return () => controller.abort();
  }, [selectedLead, selectedLocationId, detailsRefreshToken]);

  useEffect(() => {
    if (!selectedLead) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedLead(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedLead]);

  const openLeadDetails = (lead: LeadRow) => {
    setSelectedLead(lead);
    setSelectedContact(null);
    setDetailsError(null);
    setDetailsLoading(Boolean(lead.contactId));
  };

  const closeLeadDetails = () => {
    setSelectedLead(null);
    setSelectedContact(null);
    setDetailsError(null);
    setDetailsLoading(false);
  };

  const refreshLeadDetails = () => {
    setDetailsRefreshToken((prev) => prev + 1);
  };

  const ghlContactUrl = useMemo(() => {
    if (!selectedLocationId || !selectedLead?.contactId) return null;
    return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(
      selectedLocationId
    )}/contacts/detail/${encodeURIComponent(selectedLead.contactId)}`;
  }, [selectedLocationId, selectedLead]);

  const selectedLeadName = selectedLead ? toName(selectedLead) : "Lead";
  const selectedContactName = [selectedContact?.firstName, selectedContact?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  const selectedSource =
    selectedContact?.source?.trim() || selectedLead?.source?.trim() || "Leeg";

  const selectedAddress = [
    selectedContact?.city,
    selectedContact?.state,
    selectedContact?.country,
  ]
    .filter(Boolean)
    .join(", ");

  const extraContactFields = useMemo(() => {
    const raw = selectedContact?.raw;
    if (!raw) return [] as Array<{ key: string; value: string }>;

    const knownKeys = new Set(
      [
        "id",
        "firstname",
        "lastname",
        "name",
        "email",
        "phone",
        "source",
        "dateadded",
        "dateupdated",
        "tags",
        "city",
        "state",
        "country",
        "postalcode",
        "timezone",
        "dnd",
        "attributionsource",
        "lastattributionsource",
        "locationid",
      ].map(normalizeKey)
    );

    return Object.entries(raw)
      .filter(([key, value]) => !knownKeys.has(normalizeKey(key)) && hasValue(value))
      .slice(0, 24)
      .map(([key, value]) => ({
        key: toLabel(key),
        value: formatUnknownValue(value),
      }));
  }, [selectedContact]);

  const stageOptions = useMemo(() => {
    const stageSet = new Set<string>();
    availableStages.forEach((stage) => {
      if (isRealGhlStage(stage)) {
        stageSet.add(stage);
      }
    });
    if (stats) {
      Object.keys(stats.byStage)
        .filter(isRealGhlStage)
        .forEach((stage) => stageSet.add(stage));
    }
    if (stageSet.size === 0) {
      leads.forEach((lead) => {
        const stage = lead.pipelineStageName?.trim();
        if (stage && isRealGhlStage(stage)) {
          stageSet.add(stage);
        }
      });
    }
    if (stageFilter !== "all" && isRealGhlStage(stageFilter)) {
      stageSet.add(stageFilter);
    }
    return Array.from(stageSet).sort((a, b) => a.localeCompare(b, "nl-BE"));
  }, [availableStages, stats, leads, stageFilter]);

  const totalInScope =
    stageFilter === "all" ? stats?.total : (stats?.byStage[stageFilter] ?? 0);

  const summaryScope = stageFilter === "all" ? "alle stages" : `stage "${stageFilter}"`;
  const opportunityLabel =
    totalInScope === undefined
      ? "opportunities"
      : totalInScope === 1
        ? "opportunity"
        : "opportunities";

  const loadStatusLabel = useMemo(() => {
    if (statsLoading && !stats) {
      return `Teller ophalen (${summaryScope})...`;
    }
    if (totalInScope !== undefined) {
      return `${leads.length} geladen van ${totalInScope} (${summaryScope})${
        stats?.partial ? " · teller niet volledig" : ""
      }`;
    }
    return `${leads.length} geladen (${summaryScope})`;
  }, [summaryScope, statsLoading, stats, leads.length, totalInScope]);

  return (
    <div className="ghl-shell ghl-shell--leads">
      <aside className="ghl-sidebar">
        <div className="ghl-brand">
          <span className="ghl-brand__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="ghl-icon">
              <path d="M4 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm6-3h4a2 2 0 0 1 2 2v1H8V6a2 2 0 0 1 2-2z" />
            </svg>
          </span>
          <div>
            <strong>LeadPilot</strong>
            <span>Lead Management</span>
          </div>
        </div>

        <div className="ghl-account">
          <label>Subaccount</label>
          <select
            className="input"
            value={selectedLocationId ?? ""}
            onChange={(event) => {
              setStageFilter("all");
              setSelectedLocationId(event.target.value);
            }}
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
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
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
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
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
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
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
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
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
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
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

      <main className="ghl-main ghl-main--leads">
        <header className="ghl-main__header ghl-main__header--leads">
          <div>
            <h1>Leads</h1>
            <p>Beheer en volg al je leads uit GoHighLevel.</p>
          </div>
          <div className="header-actions">
            {lastSyncedAt ? (
              <span className="ghl-sync-status">
                Laatste sync: {formatSyncTime(lastSyncedAt)}
              </span>
            ) : null}
            <button
              className="button button--ghost"
              onClick={handleSync}
              disabled={loading || syncing || !selectedLocationId}
            >
              {syncing ? "Syncen..." : "Sync"}
            </button>
            <a className="toggle" href="/">
              Terug naar inbox
            </a>
          </div>
        </header>

        <section className="panel panel--leads">
          <div className="panel__body">
            <div className="ghl-filters ghl-filters--grid">
              <label className="ghl-search">
                <span className="ghl-search__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                    <path d="M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm9 16-4.2-4.2" />
                  </svg>
                </span>
                <input
                  className="input"
                  placeholder="Zoek op naam, e-mail of postcode..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <select
                className="input"
                value={stageFilter}
                onChange={(event) => setStageFilter(event.target.value)}
              >
                <option value="all">Alle stages</option>
                {stageOptions.map((stage) => (
                  <option key={stage} value={stage}>
                    {stage}
                  </option>
                ))}
              </select>
              <button className="button button--ghost" onClick={() => fetchLeads("reset")}>
                Zoek
              </button>
            </div>
            <div className="ghl-lead-summary">
              <div className="ghl-lead-summary__pill" aria-live="polite">
                <strong>{totalInScope ?? "..."}</strong>
                <span>{opportunityLabel}</span>
              </div>
              <div className="ghl-lead-summary__meta">{loadStatusLabel}</div>
            </div>

            {error ? <div className="alert alert--error">{error}</div> : null}
            {loading ? <div className="alert alert--note">Leads laden...</div> : null}
            {statsError ? <div className="alert alert--note">{statsError}</div> : null}

            <div className="ghl-table ghl-table--leads">
              <div className="ghl-table__head ghl-table__head--leads">
                <span>Naam</span>
                <span>Postcode</span>
                <span>Stage</span>
                <span>Laatste activiteit</span>
                <span>Kanalen</span>
                <span>Source</span>
                <span></span>
              </div>
              {leads.map((lead) => (
                <div
                  key={lead.id}
                  className="ghl-table__row ghl-table__row--leads ghl-table__row--leads-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => openLeadDetails(lead)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openLeadDetails(lead);
                    }
                  }}
                >
                  <div className="ghl-table__cell ghl-table__cell--name">
                    <div className="ghl-avatar">{toName(lead).slice(0, 2).toUpperCase()}</div>
                    <div className="ghl-lead-identity">
                      <strong className="ghl-lead-name">{toName(lead)}</strong>
                      <span className="ghl-lead-email">
                        {lead.contactEmail ?? "Geen e-mail"}
                      </span>
                    </div>
                  </div>
                  <div className="ghl-lead-location">
                    <strong>{lead.postalCode ?? "—"}</strong>
                    <span>{lead.city ?? "Onbekend"}</span>
                  </div>
                  <div>
                    <span className={stagePillClass(lead.pipelineStageName)}>
                      {toStageLabel(lead.pipelineStageName)}
                    </span>
                  </div>
                  <span className="ghl-lead-activity">
                    {timeAgo(lead.updatedAt ?? lead.createdAt ?? lead.dateAdded)}
                  </span>
                  <div className="ghl-channels">
                    {lead.contactPhone ? (
                      <span className="ghl-channel" aria-hidden="true">
                        <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                          <path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V7a2 2 0 0 1 2-2z" />
                        </svg>
                      </span>
                    ) : null}
                    {lead.contactEmail ? (
                      <span className="ghl-channel" aria-hidden="true">
                        <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                          <path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm0 2l8 5 8-5" />
                        </svg>
                      </span>
                    ) : null}
                    {!lead.contactPhone && !lead.contactEmail ? <span>—</span> : null}
                  </div>
                  <span className="ghl-pill ghl-pill--workflow ghl-lead-source">
                    {lead.source?.trim() || "Leeg"}
                  </span>
                  <button
                    className="ghl-menu ghl-menu--soft"
                    aria-label={`Open details van ${toName(lead)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      openLeadDetails(lead);
                    }}
                  >
                    ⋯
                  </button>
                </div>
              ))}
              {leads.length === 0 && !loading ? (
                <div className="empty">Geen leads gevonden.</div>
              ) : null}
            </div>

            <div className="ghl-pagination">
              <span>
                {statsLoading
                  ? `${leads.length} leads geladen`
                  : totalInScope !== undefined
                    ? `${leads.length} van ${totalInScope} leads geladen`
                    : `${leads.length} leads geladen`}
                {stats?.partial ? " (teller niet volledig)" : ""}
              </span>
              <button
                className="button button--ghost"
                onClick={() => fetchLeads("more")}
                disabled={!searchAfter || loading}
              >
                Laad meer
              </button>
            </div>
          </div>
        </section>

        {selectedLead ? (
          <div className="modal modal--lead-details" onClick={closeLeadDetails}>
            <div
              className="modal__content modal__content--large modal__content--lead-details"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal__header">
                <div>
                  <h2>{selectedContactName || selectedLeadName}</h2>
                  <p className="ghl-lead-modal__meta">
                    Lead details vanuit GoHighLevel
                  </p>
                </div>
                <button className="button button--ghost" onClick={closeLeadDetails}>
                  Sluiten
                </button>
              </div>

              <div className="modal__body">
                <div className="ghl-lead-modal__actions">
                  <button
                    className="button"
                    onClick={() => {
                      if (!ghlContactUrl) return;
                      window.open(ghlContactUrl, "_blank", "noopener,noreferrer");
                    }}
                    disabled={!ghlContactUrl}
                  >
                    Open in GHL
                  </button>
                  <button
                    className="button button--ghost"
                    onClick={refreshLeadDetails}
                    disabled={!selectedLead.contactId || detailsLoading}
                  >
                    {detailsLoading ? "Ophalen..." : "Ververs gegevens"}
                  </button>
                </div>

                {!selectedLead.contactId ? (
                  <div className="alert alert--note">
                    Deze lead heeft geen gekoppeld `contactId`, daarom zijn uitgebreide
                    contactdetails niet beschikbaar.
                  </div>
                ) : null}
                {detailsError ? <div className="alert alert--error">{detailsError}</div> : null}
                {detailsLoading ? (
                  <div className="alert alert--note">Lead details laden...</div>
                ) : null}

                <div className="ghl-lead-modal__grid">
                  <section className="ghl-lead-modal__card">
                    <h3>Overzicht</h3>
                    <div className="ghl-lead-modal__list">
                      <div className="ghl-lead-modal__item">
                        <span>Naam</span>
                        <strong>{selectedContactName || selectedLeadName}</strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>E-mail</span>
                        <strong>{selectedContact?.email || selectedLead.contactEmail || "—"}</strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>Telefoon</span>
                        <strong>{selectedContact?.phone || selectedLead.contactPhone || "—"}</strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>Source</span>
                        <strong>{selectedSource}</strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>Stage</span>
                        <strong>{toStageLabel(selectedLead.pipelineStageName)}</strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>DND</span>
                        <strong>
                          {selectedContact?.dnd === undefined
                            ? "Onbekend"
                            : selectedContact.dnd
                              ? "Ja"
                              : "Nee"}
                        </strong>
                      </div>
                    </div>
                  </section>

                  <section className="ghl-lead-modal__card">
                    <h3>IDs & tijd</h3>
                    <div className="ghl-lead-modal__list">
                      <div className="ghl-lead-modal__item">
                        <span>Opportunity ID</span>
                        <strong>{selectedLead.id}</strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>Contact ID</span>
                        <strong>{selectedLead.contactId || "—"}</strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>Aangemaakt</span>
                        <strong>
                          {formatDateTime(
                            selectedContact?.dateAdded ||
                              selectedLead.createdAt ||
                              selectedLead.dateAdded
                          )}
                        </strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>Laatst aangepast</span>
                        <strong>
                          {formatDateTime(
                            selectedContact?.dateUpdated || selectedLead.updatedAt
                          )}
                        </strong>
                      </div>
                    </div>
                  </section>

                  <section className="ghl-lead-modal__card">
                    <h3>Adres & regio</h3>
                    <div className="ghl-lead-modal__list">
                      <div className="ghl-lead-modal__item">
                        <span>Postcode</span>
                        <strong>
                          {selectedContact?.postalCode || selectedLead.postalCode || "—"}
                        </strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>Plaats</span>
                        <strong>{selectedContact?.city || selectedLead.city || "—"}</strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>Regio</span>
                        <strong>{selectedAddress || "—"}</strong>
                      </div>
                      <div className="ghl-lead-modal__item">
                        <span>Tijdzone</span>
                        <strong>{selectedContact?.timezone || "—"}</strong>
                      </div>
                    </div>
                  </section>

                  <section className="ghl-lead-modal__card">
                    <h3>Tags</h3>
                    {selectedContact?.tags?.length ? (
                      <div className="ghl-lead-modal__tags">
                        {selectedContact.tags.map((tag) => (
                          <span key={tag} className="ghl-lead-modal__tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="ghl-muted">Geen tags beschikbaar.</div>
                    )}
                  </section>

                  <section className="ghl-lead-modal__card ghl-lead-modal__card--full">
                    <h3>Extra GHL velden</h3>
                    {extraContactFields.length > 0 ? (
                      <div className="ghl-lead-modal__extras">
                        {extraContactFields.map((field, index) => (
                          <div
                            className="ghl-lead-modal__extra"
                            key={`${field.key}-${index}`}
                          >
                            <span>{field.key}</span>
                            <strong>{field.value}</strong>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="ghl-muted">Geen extra velden gevonden voor deze lead.</div>
                    )}
                  </section>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
};

export default GhlLeads;
