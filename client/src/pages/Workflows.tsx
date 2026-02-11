import React, { useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import type { WorkflowStatus } from "../types";

type Location = { id: string; name: string };

type WorkflowListItem = {
  id: string;
  name: string;
  status: WorkflowStatus;
  updatedAt: string;
};

const statusLabel = (status: WorkflowStatus) => {
  if (status === "active") return "Actief";
  if (status === "inactive") return "Inactief";
  return "Draft";
};

const statusClass = (status: WorkflowStatus) => {
  if (status === "active") return "ghl-pill ghl-pill--status ghl-pill--status-active";
  if (status === "inactive") return "ghl-pill ghl-pill--status ghl-pill--status-lost";
  return "ghl-pill ghl-pill--status";
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("nl-NL", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

const Workflows: React.FC = () => {
  const navigate = useNavigate();
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [rows, setRows] = useState<WorkflowListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const load = async () => {
      const response = await fetch("/api/locations");
      const data = await response.json().catch(() => ({}));
      setLocations(data.locations ?? []);
    };
    load();
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

  const loadWorkflows = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/workflows");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Laden mislukt.");
      setRows(data.workflows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Laden mislukt.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkflows();
  }, []);

  const handleDelete = async (row: WorkflowListItem, event: React.MouseEvent) => {
    event.stopPropagation();
    const confirmed = window.confirm(`Workflow "${row.name}" verwijderen?`);
    if (!confirmed) return;
    setDeletingId(row.id);
    setError(undefined);
    try {
      const response = await fetch(`/api/workflows/${row.id}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Verwijderen mislukt.");
      setRows((prev) => prev.filter((item) => item.id !== row.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verwijderen mislukt.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="ghl-shell ghl-shell--workflows">
      <aside className="ghl-sidebar">
        <div className="ghl-brand">
          <span className="ghl-brand__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="ghl-icon">
              <path d="M4 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm6-3h4a2 2 0 0 1 2 2v1H8V6a2 2 0 0 1 2-2z" />
            </svg>
          </span>
          <div>
            <strong>LeadPilot</strong>
            <span>Workflows</span>
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

      <main className="ghl-main ghl-main--workflows">
        <header className="ghl-main__header ghl-main__header--workflows">
          <div>
            <h1>Workflows</h1>
            <p>Maak en beheer je automatische opvolging</p>
          </div>
          <div className="header-actions">
            <button className="button" onClick={() => navigate("/workflows/new")}>
              + Nieuwe workflow
            </button>
          </div>
        </header>

        <section className="panel panel--workflows">
          {error ? <div className="alert alert--error">{error}</div> : null}
          <div className="workflow-list__toolbar">
            <button className="button button--ghost" onClick={loadWorkflows} disabled={loading}>
              Vernieuwen
            </button>
          </div>

          <div className="workflow-list__table">
            <div className="ghl-table ghl-table--workflows">
              <div className="ghl-table__head ghl-table__head--workflows">
                <div>Naam</div>
                <div>Status</div>
                <div>Laatst aangepast</div>
                <div>Acties</div>
              </div>
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="ghl-table__row ghl-table__row--workflows"
                  onClick={() => navigate(`/workflows/${row.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      navigate(`/workflows/${row.id}`);
                    }
                  }}
                >
                  <div className="workflow-list__name">{row.name}</div>
                  <div>
                    <span className={statusClass(row.status)}>{statusLabel(row.status)}</span>
                  </div>
                  <div className="workflow-list__date">{formatDate(row.updatedAt)}</div>
                  <div className="workflow-list__actions">
                    <button
                      className="button button--ghost workflow-delete"
                      onClick={(event) => handleDelete(row, event)}
                      disabled={deletingId === row.id}
                    >
                      {deletingId === row.id ? "..." : "Verwijder"}
                    </button>
                  </div>
                </div>
              ))}
              {!loading && rows.length === 0 ? <div className="empty">Nog geen workflows.</div> : null}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default Workflows;
