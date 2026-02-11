import React, { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import ThreadView from "../components/ThreadView";
import Composer, { ComposerSuggestMode } from "../components/Composer";
import { AiAgent, Message, MessageFilter } from "../types";
import { loadAgents } from "../utils/aiAgents";
import { fetchAgentsForLocation } from "../utils/agentApi";

type Location = { id: string; name: string };

type ConversationRow = {
  id: string;
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  lastMessageBody?: string;
  lastMessageDate?: string;
  unreadCount?: number;
  channel?: string;
  pipelineStageName?: string;
  agentOutcome?: "sales_handover" | "review_needed" | "lost";
  agentOutcomeReason?: string;
};

type ConversationsResponse = {
  conversations: ConversationRow[];
};

type ContactDetails = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  source?: string;
  dateAdded?: string;
};

const apiRequest = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  const data = await response
    .json()
    .catch(() => ({ error: "Onverwachte response." }));

  if (!response.ok) {
    const message = (data as { error?: string })?.error || "Er ging iets mis.";
    throw new Error(message);
  }

  return data as T;
};

const sortMessages = (items: Message[]) => {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.timestamp ?? "") || 0;
    const bTime = Date.parse(b.timestamp ?? "") || 0;
    return aTime - bTime;
  });
};

const toName = (row: ConversationRow) =>
  row.contactName?.trim() ||
  row.contactEmail?.split("@")[0] ||
  row.contactPhone ||
  "Onbekend";

const stageClass = (value?: string) => {
  const lower = value?.toLowerCase() ?? "";
  if (lower.includes("review")) return "ghl-stage ghl-stage--review";
  if (lower.includes("sales")) return "ghl-stage ghl-stage--sales";
  if (lower.includes("afspraak")) return "ghl-stage ghl-stage--planned";
  if (lower.includes("lost")) return "ghl-stage ghl-stage--lost";
  if (lower.includes("nurture")) return "ghl-stage ghl-stage--nurture";
  return "ghl-stage";
};

const outcomeClass = (value?: ConversationRow["agentOutcome"]) => {
  if (value === "review_needed") return "ghl-stage ghl-stage--review";
  if (value === "sales_handover") return "ghl-stage ghl-stage--sales";
  if (value === "lost") return "ghl-stage ghl-stage--lost";
  return "ghl-stage";
};

const outcomeLabel = (value?: ConversationRow["agentOutcome"]) => {
  if (value === "review_needed") return "Review Nodig";
  if (value === "sales_handover") return "Sales Overdracht";
  if (value === "lost") return "Lost";
  return null;
};

const outcomeReasonLabel = (value?: string) => {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (raw.startsWith("lost_ai:")) return raw.slice("lost_ai:".length).trim() || "AI lost-detectie";
  if (raw === "lost_ai") return "AI lost-detectie";
  if (raw === "follow_up_limit_reached") return "Follow-up limiet bereikt";
  if (raw === "handoff_required") return "Menselijke opvolging vereist";
  return raw;
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

const GhlConversations: React.FC = () => {
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<ConversationRow | null>(null);
  const [selectedContactDetails, setSelectedContactDetails] =
    useState<ContactDetails | null>(null);
  const [agents, setAgents] = useState<AiAgent[]>(() => loadAgents());
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageFilter, setMessageFilter] = useState<MessageFilter>("ALL");
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | undefined>();
  const [pagination, setPagination] = useState<{
    nextPage: boolean;
    lastMessageId?: string;
  }>({ nextPage: false });
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [readConversationIds, setReadConversationIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<
    "all" | "unread" | "read" | "review" | "sales" | "lost"
  >("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<"SMS" | "EMAIL">("SMS");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestMode, setSuggestMode] = useState<ComposerSuggestMode>("standard");
  const [sendError, setSendError] = useState<string | undefined>();
  const [sendSuccess, setSendSuccess] = useState<string | undefined>();
  const [suggestMeta, setSuggestMeta] = useState<{
    usd?: number;
    eur?: number;
    usdToEurRate?: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    handoffRequired?: boolean;
    handoffReason?: string;
    safetyFlags?: string[];
    followUpLimitReached?: boolean;
    responseSpeed?: string;
  } | null>(null);

  const loadLocations = async () => {
    const response = await fetch("/api/locations");
    const data = await response.json().catch(() => ({}));
    setLocations(data.locations ?? []);
  };

  useEffect(() => {
    loadLocations();
  }, []);

  const subaccountOptions = useMemo(() => {
    const preferred = ["Vastgoed", "Dakwerken", "Gevelwerken"];
    const filtered = locations.filter((loc) => preferred.includes(loc.name));
    return filtered.length ? filtered : locations;
  }, [locations]);
  const readConversationIdSet = useMemo(
    () => new Set(readConversationIds),
    [readConversationIds]
  );

  useEffect(() => {
    if (!selectedLocationId && subaccountOptions.length > 0) {
      setSelectedLocationId(subaccountOptions[0].id);
    }
  }, [selectedLocationId, subaccountOptions]);

  const fetchConversations = async () => {
    if (!selectedLocationId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("locationId", selectedLocationId);
      params.set("inboundOnly", "true");
      const response = await fetch(`/api/conversations/recent?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as ConversationsResponse;
      if (!response.ok) {
        throw new Error((data as { error?: string }).error || "Gesprekken ophalen mislukt.");
      }
      const nextRows = data.conversations ?? [];
      setRows(nextRows);
      const storageKey = `ghl-read-conversations:${selectedLocationId}`;
      let storedReadIds: string[] = [];
      try {
        const raw = window.localStorage.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          storedReadIds = parsed.filter(
            (item): item is string => typeof item === "string"
          );
        }
      } catch {
        storedReadIds = [];
      }
      const validReadIds = storedReadIds.filter((id) =>
        nextRows.some((row) => row.id === id)
      );
      setReadConversationIds(validReadIds);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(validReadIds));
      } catch {
        // Ignore storage errors and continue with in-memory state.
      }
      setSelectedConversation(null);
      setSelectedContactDetails(null);
      setMessages([]);
      setPagination({ nextPage: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gesprekken ophalen mislukt.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedLocationId) {
      fetchConversations();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocationId]);

  useEffect(() => {
    if (!selectedLocationId) return;
    fetchAgentsForLocation(selectedLocationId)
      .then((remote) => {
        setAgents(remote);
        setSelectedAgentId((prev) =>
          prev && remote.some((agent) => agent.id === prev) ? prev : null
        );
      })
      .catch(() => {
        const fallback = loadAgents();
        setAgents(fallback);
        setSelectedAgentId((prev) =>
          prev && fallback.some((agent) => agent.id === prev) ? prev : null
        );
      });
  }, [selectedLocationId]);

  const counts = useMemo(() => {
    const unread = rows.filter((row) => !readConversationIdSet.has(row.id)).length;
    const read = rows.filter((row) => readConversationIdSet.has(row.id)).length;
    const review = rows.filter((row) => row.agentOutcome === "review_needed").length;
    const sales = rows.filter((row) => row.agentOutcome === "sales_handover").length;
    const lost = rows.filter((row) => row.agentOutcome === "lost").length;
    return { unread, read, review, sales, lost };
  }, [rows, readConversationIdSet]);

  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    let list = rows;
    if (filter === "unread") list = list.filter((row) => !readConversationIdSet.has(row.id));
    if (filter === "read") list = list.filter((row) => readConversationIdSet.has(row.id));
    if (filter === "review") list = list.filter((row) => row.agentOutcome === "review_needed");
    if (filter === "sales") list = list.filter((row) => row.agentOutcome === "sales_handover");
    if (filter === "lost") list = list.filter((row) => row.agentOutcome === "lost");
    if (!normalized) return list;
    return list.filter((row) => {
      const haystack = [
        row.contactName,
        row.contactEmail,
        row.contactPhone,
        row.lastMessageBody,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [rows, query, filter, readConversationIdSet]);

  const canSendLocation = Boolean(selectedLocationId);
  const selectedConversationIsWorkflowSession = Boolean(
    selectedConversation?.id?.startsWith("workflow-agent-session-")
  );
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );
  const canSuggest =
    !selectedConversationIsWorkflowSession &&
    (suggestMode === "standard" || (suggestMode === "agent" && Boolean(selectedAgent)));

  const selectedContactName = useMemo(() => {
    if (selectedContactDetails) {
      const name = [selectedContactDetails.firstName, selectedContactDetails.lastName]
        .filter(Boolean)
        .join(" ");
      if (name) return name;
    }
    return selectedConversation?.contactName ?? "Onbekend";
  }, [selectedContactDetails, selectedConversation]);

  const selectedContactEmail =
    selectedContactDetails?.email ?? selectedConversation?.contactEmail;
  const selectedContactPhone =
    selectedContactDetails?.phone ?? selectedConversation?.contactPhone;
  const selectedContactAddress = [
    selectedContactDetails?.postalCode,
    selectedContactDetails?.city,
    selectedContactDetails?.country,
  ]
    .filter(Boolean)
    .join(" ");
  const selectedPipelineStage =
    selectedConversation?.pipelineStageName ?? "Geen stage";
  const selectedOutcome = outcomeLabel(selectedConversation?.agentOutcome);
  const selectedOutcomeReason = outcomeReasonLabel(selectedConversation?.agentOutcomeReason);
  const unreadRemainingCount = useMemo(
    () => rows.filter((row) => !readConversationIdSet.has(row.id)).length,
    [rows, readConversationIdSet]
  );
  const nextUnreadConversation = useMemo(() => {
    if (!selectedConversation) return null;
    return (
      rows.find(
        (row) =>
          row.id !== selectedConversation.id && !readConversationIdSet.has(row.id)
      ) ?? null
    );
  }, [rows, selectedConversation, readConversationIdSet]);

  const loadMessages = async (conversationId: string, lastMessageId?: string) => {
    if (!selectedLocationId) return;
    setMessagesLoading(true);
    setMessagesError(undefined);
    try {
      const params = new URLSearchParams();
      params.set("limit", "20");
      params.set("locationId", selectedLocationId);
      if (lastMessageId) params.set("lastMessageId", lastMessageId);

      const data = await apiRequest<{
        messages: Message[];
        nextPage: boolean;
        lastMessageId?: string;
      }>(`/api/conversations/${conversationId}/messages?${params.toString()}`);

      setPagination({
        nextPage: data.nextPage,
        lastMessageId: data.lastMessageId,
      });

      setMessages((prev) => {
        const combined = lastMessageId ? [...data.messages, ...prev] : data.messages;
        const unique = new Map<string, Message>();
        combined.forEach((message) => unique.set(message.id, message));
        return sortMessages(Array.from(unique.values()));
      });
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : "Fout bij laden.");
    } finally {
      setMessagesLoading(false);
    }
  };

  const loadContactDetails = async (contactId: string) => {
    if (!selectedLocationId) return;
    try {
      const data = await apiRequest<{ contact: ContactDetails }>(
        `/api/contacts/${contactId}?locationId=${selectedLocationId}`
      );
      setSelectedContactDetails(data.contact ?? null);
    } catch {
      setSelectedContactDetails(null);
    }
  };

  const handleSelectConversation = async (row: ConversationRow) => {
    const openedRow = { ...row, unreadCount: 0 };
    setReadConversationIds((prev) => {
      if (prev.includes(row.id)) return prev;
      const next = [...prev, row.id];
      if (selectedLocationId) {
        const storageKey = `ghl-read-conversations:${selectedLocationId}`;
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Ignore storage errors and continue with in-memory state.
        }
      }
      return next;
    });
    setRows((prev) =>
      prev.map((item) => (item.id === row.id ? openedRow : item))
    );
    setSelectedConversation(openedRow);
    setSelectedContactDetails(null);
    setMessages([]);
    setPagination({ nextPage: false });
    await loadMessages(row.id);
    if (row.contactId) {
      await loadContactDetails(row.contactId);
    }
  };
  const handleBackToList = () => {
    setSelectedConversation(null);
    setSelectedContactDetails(null);
    setMessages([]);
    setPagination({ nextPage: false });
  };
  const handleSelectNextUnread = async () => {
    if (!nextUnreadConversation) return;
    await handleSelectConversation(nextUnreadConversation);
  };

  const handleLoadOlder = async () => {
    if (!selectedConversation || !pagination.nextPage || !pagination.lastMessageId) return;
    await loadMessages(selectedConversation.id, pagination.lastMessageId);
  };

  const handleSuggest = async () => {
    if (selectedConversationIsWorkflowSession) {
      setSendError(
        "Workflow-agent gesprekken zijn read-only in Composer. Antwoorden lopen automatisch via de agent."
      );
      return;
    }
    if (!selectedConversation?.contactId || !selectedLocationId) {
      setSendError("Selecteer eerst een gesprek.");
      return;
    }
    if (suggestMode === "agent" && !selectedAgent) {
      setSendError("Kies eerst een AI Agent.");
      return;
    }
    setSuggesting(true);
    setSendError(undefined);
    try {
      const data = await apiRequest<{
        suggestion: {
          text: string;
          usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
          cost?: {
            usd?: number;
            eur?: number;
            usdToEurRate?: number;
            model?: string;
          };
          policy?: {
            responseSpeed?: string;
            followUpLimitReached?: boolean;
            handoffRequired?: boolean;
            handoffReason?: string;
            safetyFlags?: string[];
          };
        };
        stageUpdate?: {
          marked?: boolean;
          stageName?: string;
        };
      }>("/api/suggest", {
        method: "POST",
        body: JSON.stringify({
          conversationId: selectedConversation.id,
          contactId: selectedConversation.contactId,
          locationId: selectedLocationId,
          agentId:
            suggestMode === "agent" && selectedAgent?.locationId
              ? selectedAgent.id
              : undefined,
          agent: suggestMode === "agent" ? selectedAgent ?? undefined : undefined,
        }),
      });
      setBody(data.suggestion.text);
      if (data.stageUpdate?.marked && data.stageUpdate.stageName && selectedConversation) {
        const nextStage = data.stageUpdate.stageName.trim();
        if (nextStage) {
          setRows((prev) =>
            prev.map((row) =>
              row.id === selectedConversation.id
                ? { ...row, pipelineStageName: nextStage }
                : row
            )
          );
          setSelectedConversation((prev) =>
            prev ? { ...prev, pipelineStageName: nextStage } : prev
          );
        }
      }
      if (data.suggestion.cost || data.suggestion.usage) {
        setSuggestMeta({
          usd: data.suggestion.cost?.usd,
          eur: data.suggestion.cost?.eur,
          usdToEurRate: data.suggestion.cost?.usdToEurRate,
          model: data.suggestion.cost?.model,
          inputTokens: data.suggestion.usage?.inputTokens,
          outputTokens: data.suggestion.usage?.outputTokens,
          totalTokens: data.suggestion.usage?.totalTokens,
          handoffRequired: data.suggestion.policy?.handoffRequired,
          handoffReason: data.suggestion.policy?.handoffReason,
          safetyFlags: data.suggestion.policy?.safetyFlags,
          followUpLimitReached: data.suggestion.policy?.followUpLimitReached,
          responseSpeed: data.suggestion.policy?.responseSpeed,
        });
      } else {
        setSuggestMeta(null);
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Fout bij suggestie.");
    } finally {
      setSuggesting(false);
    }
  };

  const handleSend = async () => {
    if (selectedConversationIsWorkflowSession) {
      setSendError(
        "Workflow-agent gesprekken zijn read-only in Composer. Antwoorden lopen automatisch via de agent."
      );
      return;
    }
    if (!selectedConversation?.contactId || !selectedLocationId) {
      setSendError("Selecteer eerst een gesprek.");
      return;
    }
    setSending(true);
    setSendError(undefined);
    setSendSuccess(undefined);
    try {
      const payload = {
        conversationId: selectedConversation.id,
        contactId: selectedConversation.contactId,
        channel,
        subject: channel === "EMAIL" ? subject : undefined,
        body,
        locationId: selectedLocationId,
      };
      const data = await apiRequest<{
        success: boolean;
        messageId?: string;
        emailMessageId?: string;
      }>("/api/conversations/messages", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setSendSuccess(
        `Verzonden. messageId: ${data.messageId ?? "-"}` +
          (data.emailMessageId ? `, emailMessageId: ${data.emailMessageId}` : "")
      );
      const optimisticId = data.messageId ?? data.emailMessageId ?? `local-${Date.now()}`;
      const optimistic: Message = {
        id: optimisticId,
        conversationId: selectedConversation.id,
        contactId: selectedConversation.contactId,
        type: channel === "EMAIL" ? "TYPE_EMAIL" : "TYPE_SMS",
        direction: "outbound",
        body,
        subject: channel === "EMAIL" ? subject : undefined,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => {
        const unique = new Map<string, Message>();
        [...prev, optimistic].forEach((message) => unique.set(message.id, message));
        return sortMessages(Array.from(unique.values()));
      });
      setBody("");
      setSubject("");
      setConfirmChecked(false);
      setSuggestMeta(null);
      await loadMessages(selectedConversation.id);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Fout bij versturen.");
    } finally {
      setSending(false);
    }
  };

  const filteredMessages = useMemo(() => {
    if (messageFilter === "ALL") return messages;
    return messages.filter((message) => message.type === messageFilter);
  }, [messages, messageFilter]);

  const handleSuggestModeChange = (mode: ComposerSuggestMode) => {
    setSuggestMode(mode);
    setSuggestMeta(null);
    setSendError(undefined);
  };

  return (
    <div className="ghl-shell ghl-shell--conversations">
      <aside className="ghl-sidebar">
        <div className="ghl-brand">
          <span className="ghl-brand__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="ghl-icon">
              <path d="M4 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm6-3h4a2 2 0 0 1 2 2v1H8V6a2 2 0 0 1 2-2z" />
            </svg>
          </span>
          <div>
            <strong>LeadPilot</strong>
            <span>Conversations</span>
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

      <main className="ghl-main ghl-main--conversations">
        <header className="ghl-main__header ghl-main__header--conversations">
          <div>
            <h1>Conversations</h1>
            <p>Lopende gesprekken met leads</p>
          </div>
          <div className="header-actions">
            <a className="toggle" href="/">
              Terug naar inbox
            </a>
          </div>
        </header>

        <section className="panel panel--conversations">
          <div className="panel__body">
            <div className="ghl-convo-tabs ghl-convo-tabs--conversations">
              <button
                className={`ghl-tab ${filter === "all" ? "ghl-tab--active" : ""}`}
                onClick={() => setFilter("all")}
              >
                <span className="ghl-tab__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                    <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
                  </svg>
                </span>
                Alle <span className="ghl-tab__count">{rows.length}</span>
              </button>
              <button
                className={`ghl-tab ${filter === "unread" ? "ghl-tab--active" : ""}`}
                onClick={() => setFilter("unread")}
              >
                <span className="ghl-tab__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                    <path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm0 2l8 5 8-5" />
                  </svg>
                </span>
                Ongelezen <span className="ghl-tab__count">{counts.unread}</span>
              </button>
              <button
                className={`ghl-tab ${filter === "read" ? "ghl-tab--active" : ""}`}
                onClick={() => setFilter("read")}
              >
                <span className="ghl-tab__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                    <path d="M9.5 12.8l-2.3-2.3-1.4 1.4 3.7 3.7 8-8-1.4-1.4z" />
                  </svg>
                </span>
                Gelezen <span className="ghl-tab__count">{counts.read}</span>
              </button>
              <button
                className={`ghl-tab ${filter === "sales" ? "ghl-tab--active" : ""}`}
                onClick={() => setFilter(filter === "sales" ? "all" : "sales")}
              >
                <span className="ghl-tab__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                    <path d="M7.5 12a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm9 0a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM3 20.5c0-3 3-5.5 6.5-5.5S16 17.5 16 20.5V22H3v-1.5zm9.5 1.5v-1.5c0-1.6-.6-3-1.6-4.1.8-.3 1.7-.4 2.6-.4 3.6 0 6.5 2.5 6.5 5.5V22h-7.5z" />
                  </svg>
                </span>
                Sales Overdracht <span className="ghl-tab__count">{counts.sales}</span>
              </button>
              <button
                className={`ghl-tab ${filter === "review" ? "ghl-tab--active" : ""}`}
                onClick={() => setFilter(filter === "review" ? "all" : "review")}
              >
                <span className="ghl-tab__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                    <path d="M12 7v6l4 2M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z" />
                  </svg>
                </span>
                Review Nodig <span className="ghl-tab__count">{counts.review}</span>
              </button>
              <button
                className={`ghl-tab ${filter === "lost" ? "ghl-tab--active" : ""}`}
                onClick={() => setFilter(filter === "lost" ? "all" : "lost")}
              >
                <span className="ghl-tab__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                    <path d="M6 6l12 12M6 18L18 6M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z" />
                  </svg>
                </span>
                Lost <span className="ghl-tab__count">{counts.lost}</span>
              </button>
            </div>

            <div className="ghl-filters ghl-filters--grid ghl-filters--conversations">
              <label className="ghl-search">
                <span className="ghl-search__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                    <path d="M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm9 16-4.2-4.2" />
                  </svg>
                </span>
                <input
                  className="input"
                  placeholder="Zoek in gesprekken..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <select className="input" disabled>
                <option>Alle eigenaars</option>
              </select>
              <select className="input" disabled>
                <option>Alle statussen</option>
              </select>
              <button className="button button--ghost" onClick={fetchConversations}>
                Zoek
              </button>
            </div>

            <div className="ghl-muted ghl-muted--spaced">
              {filteredRows.length} van {rows.length} gesprekken
            </div>

            {error ? <div className="alert alert--error">{error}</div> : null}
            {loading ? <div className="alert alert--note">Gesprekken laden...</div> : null}

            {!selectedConversation ? (
              <div className="ghl-convo-list ghl-convo-list--conversations">
                {filteredRows.map((row) => (
                  <button
                    key={row.id}
                    className="ghl-convo-row ghl-convo-row--conversations"
                    onClick={() => handleSelectConversation(row)}
                  >
                    <div className="ghl-convo-avatar">
                      {toName(row).slice(0, 2).toUpperCase()}
                      <span className="ghl-convo-avatar__badge" aria-hidden="true">
                        <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                          <path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V7a2 2 0 0 1 2-2z" />
                        </svg>
                      </span>
                    </div>
                    <div className="ghl-convo-body">
                      <div className="ghl-convo-title">
                        <strong>{toName(row)}</strong>
                        {outcomeLabel(row.agentOutcome) ? (
                          <span className={outcomeClass(row.agentOutcome)}>
                            {outcomeLabel(row.agentOutcome)}
                          </span>
                        ) : null}
                        <span className={stageClass(row.pipelineStageName)}>
                          {row.pipelineStageName ?? "Geen stage"}
                        </span>
                        {row.contactPhone ? (
                          <span className="ghl-channel" aria-hidden="true">
                            <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                              <path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V7a2 2 0 0 1 2-2z" />
                            </svg>
                          </span>
                        ) : null}
                        {row.contactEmail ? (
                          <span className="ghl-channel" aria-hidden="true">
                            <svg viewBox="0 0 24 24" className="ghl-icon ghl-icon--xs">
                              <path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm0 2l8 5 8-5" />
                            </svg>
                          </span>
                        ) : null}
                      </div>
                      <p>{row.lastMessageBody ?? "Geen preview beschikbaar."}</p>
                      {outcomeReasonLabel(row.agentOutcomeReason) ? (
                        <p className="ghl-muted">
                          Reden: {outcomeReasonLabel(row.agentOutcomeReason)}
                        </p>
                      ) : null}
                    </div>
                    <div className="ghl-convo-meta">
                      <span>{timeAgo(row.lastMessageDate)}</span>
                      {!readConversationIdSet.has(row.id) ? <span className="ghl-dot" /> : null}
                    </div>
                  </button>
                ))}

                {filteredRows.length === 0 && !loading ? (
                  <div className="empty">Geen gesprekken gevonden.</div>
                ) : null}
              </div>
            ) : (
              <div className="ghl-convo-detail-layout ghl-convo-detail-layout--conversations">
                <aside className="ghl-lead-panel ghl-lead-panel--conversations">
                  <div className="ghl-lead-actions">
                    <button className="button button--ghost" onClick={handleBackToList}>
                      ← Terug naar gesprekken
                    </button>
                    {nextUnreadConversation ? (
                      <button className="button button--ghost" onClick={handleSelectNextUnread}>
                        Volgende ongelezen
                      </button>
                    ) : (
                      <div className="ghl-muted">Inbox afgewerkt: geen ongelezen gesprekken.</div>
                    )}
                  </div>
                  <div className="ghl-muted">Ongelezen resterend: {unreadRemainingCount}</div>
                  <h3>Lead informatie</h3>
                  <div className="ghl-lead-item">
                    <span>Naam</span>
                    <strong>{selectedContactName}</strong>
                  </div>
                  <div className="ghl-lead-item">
                    <span>Telefoon</span>
                    <strong>{selectedContactPhone ?? "—"}</strong>
                  </div>
                  <div className="ghl-lead-item">
                    <span>Email</span>
                    <strong>{selectedContactEmail ?? "—"}</strong>
                  </div>
                  <div className="ghl-lead-item">
                    <span>Adres</span>
                    <strong>{selectedContactAddress || "—"}</strong>
                  </div>
                  <div className="ghl-lead-item">
                    <span>Pipeline stage</span>
                    <strong>{selectedPipelineStage}</strong>
                  </div>
                  <div className="ghl-lead-item">
                    <span>AI status</span>
                    <strong>{selectedOutcome ?? "Geen"}</strong>
                  </div>
                  <div className="ghl-lead-item">
                    <span>AI reden</span>
                    <strong>{selectedOutcomeReason ?? "—"}</strong>
                  </div>
                  <div className="ghl-lead-item">
                    <span>Bron</span>
                    <strong>
                      {selectedContactDetails?.source ??
                        (selectedConversationIsWorkflowSession ? "Workflow Agent" : "GHL")}
                    </strong>
                  </div>
                  <div className="ghl-lead-item">
                    <span>Aangemaakt</span>
                    <strong>{timeAgo(selectedContactDetails?.dateAdded)}</strong>
                  </div>
                  <div className="ghl-lead-channels">
                    {selectedContactPhone ? <span className="ghl-lead-chip">WhatsApp</span> : null}
                    {selectedContactEmail ? <span className="ghl-lead-chip">Email</span> : null}
                  </div>
                </aside>

                <div className="ghl-convo-detail ghl-convo-detail--conversations">
                  <ThreadView
                    messages={filteredMessages}
                    loading={messagesLoading}
                    error={messagesError}
                    filter={messageFilter}
                    onFilterChange={setMessageFilter}
                    onLoadMore={handleLoadOlder}
                    hasNextPage={pagination.nextPage}
                  />
                  <Composer
                    channel={channel}
                    subject={subject}
                    body={body}
                    contactInfo={{
                      name: selectedContactName,
                      email: selectedContactEmail,
                      phone: selectedContactPhone,
                    }}
                    agents={agents}
                    selectedAgentId={selectedAgentId}
                    onAgentChange={setSelectedAgentId}
                    suggestMode={suggestMode}
                    onSuggestModeChange={handleSuggestModeChange}
                    canSuggest={canSuggest}
                    onChannelChange={setChannel}
                    onSubjectChange={setSubject}
                    onBodyChange={setBody}
                    onSuggest={handleSuggest}
                    onSend={handleSend}
                    confirmChecked={confirmChecked}
                    onConfirmChange={setConfirmChecked}
                    sending={sending}
                    suggesting={suggesting}
                    error={sendError}
                    success={sendSuccess}
                    canSend={
                      canSendLocation &&
                      !selectedConversationIsWorkflowSession &&
                      !!body.trim() &&
                      confirmChecked &&
                      (channel === "SMS" || (channel === "EMAIL" && !!subject.trim()))
                    }
                    suggestMeta={suggestMeta}
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default GhlConversations;
