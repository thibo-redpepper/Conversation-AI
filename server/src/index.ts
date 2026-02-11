import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { getContactById, searchContacts } from "./ghl/contacts.js";
import {
  getLatestOpportunityStage,
  getPipelineStageMap,
  listOpportunities,
  updateLatestOpportunityStageByName,
} from "./ghl/opportunities.js";
import {
  filterConversationsWithInbound,
  getConversationById,
  listAllMessages,
  listConversations,
  listConversationsPaged,
  listMessages,
} from "./ghl/conversations.js";
import { sendMessage } from "./ghl/sendMessage.js";
import { GhlError, GhlConfig } from "./ghl/client.js";
import { renderContactTemplate, suggestReply } from "./ai/suggest.js";
import { suggestCrmReply } from "./ai/crmSuggest.js";
import { classifyLostDraft } from "./ai/lostDraft.js";
import { getAccountEntries, getGhlConfigForAccount } from "./ghl/accounts.js";
import { startBackgroundSync, syncNow, syncNowWithOptions } from "./sync/ghlSync.js";
import { getSupabaseClient } from "./supabase/client.js";
import axios from "axios";
import crypto from "crypto";
import multer from "multer";
import twilio from "twilio";
import { cleanEmailReply, extractEmail } from "./shared/email.js";
import { sendSmsViaTwilio } from "./services/twilioSend.js";
import { sendEmailViaMailgun } from "./services/mailgunSend.js";
import { buildLinearChain } from "./workflows/validation.js";
import { runWorkflowTest } from "./workflows/runner.js";
import {
  appendWorkflowEnrollmentSteps,
  createWorkflow,
  deactivateWorkflowAgentSessionsByEnrollment,
  deleteWorkflowEnrollment,
  deleteWorkflow,
  findActiveWorkflowAgentSessionForInbound,
  getWorkflowEnrollment,
  getWorkflow,
  listActiveWorkflowAgentSessions,
  listWorkflowAgentSessionsDueForFollowUp,
  listWorkflowAgentSessions,
  listWorkflowAgentEvents,
  listWorkflowEnrollments,
  listWorkflows,
  recordWorkflowAgentEvent,
  recordWorkflowEnrollmentExecution,
  touchWorkflowAgentSessionInbound,
  touchWorkflowAgentSessionOutbound,
  updateWorkflowAgentSessionFollowUpState,
  upsertWorkflowAgentSession,
  updateWorkflowEnrollmentStatus,
  updateWorkflow,
} from "./workflows/repo.js";
import {
  archiveAgent,
  createAgent,
  deleteEvalCase,
  deleteKnowledgeEntry,
  getAgent,
  getAgentStats,
  getResolvedAgentSettings,
  listAgentVersions,
  listAgents,
  listEvalCases,
  listEvalRuns,
  listHandoffs,
  listKnowledge,
  publishAgent,
  recordAgentRun,
  recordEvalRun,
  refreshAgentWebsiteKnowledge,
  refreshWebsiteKnowledgeEntry,
  rollbackAgent,
  sanitizeAgentSettings,
  updateAgent,
  upsertEvalCase,
  upsertKnowledgeNote,
} from "./agents/repo.js";
import { normalizePhoneDigits, phonesLikelyMatch } from "./shared/phone.js";

const loadEnv = () => {
  const rootEnv = path.resolve(process.cwd(), "..", ".env");
  const localEnv = path.resolve(process.cwd(), ".env");
  const envPath = fs.existsSync(rootEnv) ? rootEnv : localEnv;
  dotenv.config({ path: envPath });
};

loadEnv();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const mailgunUpload = multer();

const getGhlConfig = (locationId?: string): GhlConfig =>
  getGhlConfigForAccount(locationId);

const OPPORTUNITY_STATS_TTL_MS =
  Number(process.env.GHL_OPPORTUNITY_STATS_TTL_SEC ?? "120") * 1000;
const OPPORTUNITY_STATS_MAX_PAGES = Number(
  process.env.GHL_OPPORTUNITY_STATS_MAX_PAGES ?? "400"
);
const OPPORTUNITY_STAGE_SCAN_MAX_PAGES = Number(
  process.env.GHL_OPPORTUNITY_STAGE_SCAN_MAX_PAGES ?? "8"
);
const CONVERSATIONS_PAGE_LIMIT = Number(process.env.CONVERSATIONS_PAGE_LIMIT ?? "100");
const CONVERSATIONS_MAX_PAGES = Number(process.env.CONVERSATIONS_MAX_PAGES ?? "100");
const CONVERSATIONS_OPPORTUNITY_MAX_PAGES = Number(
  process.env.CONVERSATIONS_OPPORTUNITY_MAX_PAGES ?? "100"
);
const TWILIO_INBOUND_POLL_ENABLED =
  (process.env.TWILIO_INBOUND_POLL_ENABLED ?? "false") === "true";
const TWILIO_INBOUND_POLL_INTERVAL_MS =
  Math.max(15, Number(process.env.TWILIO_INBOUND_POLL_INTERVAL_SEC ?? "30")) * 1000;
const TWILIO_INBOUND_POLL_LOOKBACK_MINUTES = Math.max(
  15,
  Number(process.env.TWILIO_INBOUND_POLL_LOOKBACK_MIN ?? "180")
);
const TWILIO_WORKFLOW_AGENT_AUTOREPLY_ENABLED =
  (process.env.TWILIO_WORKFLOW_AGENT_AUTOREPLY_ENABLED ?? "false") === "true";
const GHL_AGENT_INBOUND_POLL_ENABLED =
  (process.env.GHL_AGENT_INBOUND_POLL_ENABLED ?? "true") === "true";
const GHL_AGENT_INBOUND_POLL_INTERVAL_MS =
  Math.max(10, Number(process.env.GHL_AGENT_INBOUND_POLL_INTERVAL_SEC ?? "20")) * 1000;
const GHL_AGENT_INBOUND_POLL_LOOKBACK_MINUTES = Math.max(
  30,
  Number(process.env.GHL_AGENT_INBOUND_POLL_LOOKBACK_MIN ?? "240")
);
const GHL_AGENT_INBOUND_SESSIONS_LIMIT = Math.max(
  20,
  Number(process.env.GHL_AGENT_INBOUND_SESSIONS_LIMIT ?? "200")
);
const WORKFLOW_AGENT_FOLLOWUP_POLL_ENABLED =
  (process.env.WORKFLOW_AGENT_FOLLOWUP_POLL_ENABLED ?? "true") === "true";
const WORKFLOW_AGENT_FOLLOWUP_POLL_INTERVAL_MS =
  Math.max(15, Number(process.env.WORKFLOW_AGENT_FOLLOWUP_POLL_INTERVAL_SEC ?? "30")) * 1000;
const WORKFLOW_AGENT_FOLLOWUP_SESSIONS_LIMIT = Math.max(
  20,
  Number(process.env.WORKFLOW_AGENT_FOLLOWUP_SESSIONS_LIMIT ?? "200")
);

type OpportunityStatsPayload = {
  total: number;
  byStage: Record<string, number>;
  cachedAt: string;
  partial: boolean;
};

type DashboardLeadSnapshotPayload = {
  total: number;
  current: number;
  previous: number;
  scanned: number;
  partial: boolean;
  cachedAt: string;
};

const opportunityStatsCache = new Map<
  string,
  { expiresAt: number; payload: OpportunityStatsPayload }
>();
const dashboardLeadSnapshotCache = new Map<
  string,
  { expiresAt: number; payload: DashboardLeadSnapshotPayload }
>();

const NO_STAGE_LABEL = "Geen stage";
const normalizeStage = (value?: string | null) =>
  (value?.trim() || NO_STAGE_LABEL).toLowerCase();
const displayStage = (value?: string | null) => value?.trim() || NO_STAGE_LABEL;

type EvalCasePayload = {
  title: string;
  payload: {
    leadName?: string;
    channel?: "SMS" | "EMAIL";
    history: Array<{ role: "lead" | "agent"; text: string }>;
  };
  expected: {
    mustInclude?: string[];
    mustNotInclude?: string[];
    maxSentences?: number;
  };
};

const DEFAULT_EVAL_CASES: EvalCasePayload[] = [
  {
    title: "Direct antwoord op concrete vraag",
    payload: {
      leadName: "Jan",
      channel: "SMS",
      history: [{ role: "lead", text: "Kan je morgen om 14u bellen?" }],
    },
    expected: { mustInclude: ["14u"], maxSentences: 3 },
  },
  {
    title: "Korte reply bij instant snelheid",
    payload: {
      leadName: "Sofie",
      channel: "SMS",
      history: [{ role: "lead", text: "Wat is de volgende stap?" }],
    },
    expected: { maxSentences: 2 },
  },
  {
    title: "Geen harde claims",
    payload: {
      leadName: "Pieter",
      channel: "EMAIL",
      history: [{ role: "lead", text: "Kan je garanderen dat dit binnen 7 dagen verkocht is?" }],
    },
    expected: { mustNotInclude: ["garanderen", "100%"] },
  },
];

const countSentences = (value: string) =>
  value
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;

const formatUnknownError = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return String((error as { message: string }).message);
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    return JSON.stringify(error);
  } catch {
    return "Onbekende fout";
  }
};

const DEFAULT_LOST_KEYWORDS = [
  "geen interesse",
  "niet geïnteresseerd",
  "niet geinteresseerd",
  "doe maar niet",
  "laat maar",
  "niet nodig",
  "annuleer",
  "annuleren",
  "stop",
  "niet meer contacteren",
];

type AgentPolicyMeta = {
  handoffRequired?: boolean;
  handoffReason?: string;
  followUpLimitReached?: boolean;
  safetyFlags?: string[];
};

type AgentOutcomeType = "sales_handover" | "review_needed" | "lost";
type OutcomeMessage = {
  direction?: string | null;
  body?: string | null;
  subject?: string | null;
  timestamp?: string | null;
};

const resolveRunOutcome = (run: {
  handoff_required?: boolean | null;
  follow_up_limit_reached?: boolean | null;
  safety_flags?: unknown;
}): Exclude<AgentOutcomeType, "lost"> | null => {
  if (run.handoff_required) return "sales_handover";
  if (run.follow_up_limit_reached) return "review_needed";
  if (Array.isArray(run.safety_flags) && run.safety_flags.length > 0) {
    return "review_needed";
  }
  return null;
};

const normalizeOutcomeReason = (value: unknown, maxLength = 280) => {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) return undefined;
  return cleaned.slice(0, maxLength);
};

const resolveRunOutcomeReason = (run: {
  handoff_required?: boolean | null;
  handoff_reason?: string | null;
  follow_up_limit_reached?: boolean | null;
  safety_flags?: unknown;
}) => {
  if (run.handoff_required) {
    return normalizeOutcomeReason(run.handoff_reason) ?? "handoff_required";
  }
  if (run.follow_up_limit_reached) return "follow_up_limit_reached";
  if (Array.isArray(run.safety_flags) && run.safety_flags.length > 0) {
    return `safety:${String(run.safety_flags[0])}`.slice(0, 280);
  }
  return undefined;
};

const normalizeAgentOutcome = (value: unknown): AgentOutcomeType | null => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "sales_handover" || raw === "sales handover") return "sales_handover";
  if (raw === "review_needed" || raw === "review needed") return "review_needed";
  if (raw === "lost") return "lost";
  return null;
};

const resolveConversationOutcomeMap = async (input: {
  locationId: string;
  conversationIds: string[];
}) => {
  const supabase = getSupabaseClient();
  if (!supabase || input.conversationIds.length === 0) {
    return new Map<string, { outcome: AgentOutcomeType; reason?: string }>();
  }

  const latestByConversation = new Map<
    string,
    { outcome: AgentOutcomeType; reason?: string; timestamp: number }
  >();
  const setIfLatest = (
    conversationId: string,
    outcome: AgentOutcomeType | null | undefined,
    createdAt?: string | null,
    reason?: string
  ) => {
    if (!outcome) return;
    const timestamp = Date.parse(String(createdAt ?? ""));
    const nextTimestamp = Number.isFinite(timestamp) ? timestamp : 0;
    const existing = latestByConversation.get(conversationId);
    if (!existing || nextTimestamp >= existing.timestamp) {
      latestByConversation.set(conversationId, {
        outcome,
        reason: normalizeOutcomeReason(reason),
        timestamp: nextTimestamp,
      });
    }
  };

  for (const chunk of chunkArray(input.conversationIds, 150)) {
    const { data, error } = await supabase
      .from("ai_agent_runs")
      .select(
        "conversation_id, handoff_required, handoff_reason, follow_up_limit_reached, safety_flags, created_at"
      )
      .eq("location_id", input.locationId)
      .eq("source", "suggest")
      .in("conversation_id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      conversation_id?: string | null;
      handoff_required?: boolean | null;
      handoff_reason?: string | null;
      follow_up_limit_reached?: boolean | null;
      safety_flags?: unknown;
      created_at?: string | null;
    }>) {
      const conversationId = String(row.conversation_id ?? "").trim();
      if (!conversationId) continue;
      setIfLatest(
        conversationId,
        resolveRunOutcome(row),
        row.created_at,
        resolveRunOutcomeReason(row)
      );
    }
  }

  const directConversationIds = input.conversationIds.filter(
    (conversationId) =>
      !conversationId.startsWith(WORKFLOW_AGENT_CONVERSATION_PREFIX)
  );
  const sessionConversationMap = new Map<string, { sessionId: string; updatedAt: number }>();
  const upsertSessionConversation = (
    conversationId: string,
    sessionId?: string | null,
    updatedAt?: string | null
  ) => {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!conversationId || !normalizedSessionId) return;
    const ts = Date.parse(String(updatedAt ?? ""));
    const nextTs = Number.isFinite(ts) ? ts : 0;
    const existing = sessionConversationMap.get(conversationId);
    if (!existing || nextTs >= existing.updatedAt) {
      sessionConversationMap.set(conversationId, {
        sessionId: normalizedSessionId,
        updatedAt: nextTs,
      });
    }
  };

  for (const chunk of chunkArray(directConversationIds, 150)) {
    const { data, error } = await supabase
      .from("workflow_agent_sessions")
      .select("id, ghl_conversation_id, updated_at")
      .eq("location_id", input.locationId)
      .in("ghl_conversation_id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      id: string;
      ghl_conversation_id?: string | null;
      updated_at?: string | null;
    }>) {
      const conversationId = String(row.ghl_conversation_id ?? "").trim();
      upsertSessionConversation(conversationId, row.id, row.updated_at);
    }
  }

  const prefixedConversationIds = input.conversationIds.filter((conversationId) =>
    conversationId.startsWith(WORKFLOW_AGENT_CONVERSATION_PREFIX)
  );
  const prefixedSessionIds = prefixedConversationIds
    .map((conversationId) =>
      parseWorkflowAgentSessionIdFromConversationId(conversationId)
    )
    .filter((value): value is string => Boolean(value));
  for (const chunk of chunkArray(prefixedSessionIds, 150)) {
    const { data, error } = await supabase
      .from("workflow_agent_sessions")
      .select("id, updated_at")
      .eq("location_id", input.locationId)
      .in("id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; updated_at?: string | null }>) {
      const conversationId = buildWorkflowAgentConversationId(row.id);
      upsertSessionConversation(conversationId, row.id, row.updated_at);
    }
  }

  const sessionIds = Array.from(
    new Set(
      Array.from(sessionConversationMap.values())
        .map((entry) => entry.sessionId)
        .filter(Boolean)
    )
  );
  if (sessionIds.length > 0) {
    const conversationIdsBySession = new Map<string, string[]>();
    for (const [conversationId, entry] of sessionConversationMap.entries()) {
      const existing = conversationIdsBySession.get(entry.sessionId) ?? [];
      existing.push(conversationId);
      conversationIdsBySession.set(entry.sessionId, existing);
    }

    for (const chunk of chunkArray(sessionIds, 150)) {
      const { data, error } = await supabase
        .from("workflow_agent_events")
        .select("session_id, event_type, payload, created_at")
        .in("event_type", ["opportunity_stage_marked", "auto_reply_sent"])
        .in("session_id", chunk);
      if (error) throw error;

      for (const row of (data ?? []) as Array<{
        session_id?: string | null;
        event_type?: string | null;
        payload?: unknown;
        created_at?: string | null;
      }>) {
        const sessionId = String(row.session_id ?? "").trim();
        if (!sessionId) continue;
        const payload =
          row.payload && typeof row.payload === "object"
            ? (row.payload as Record<string, unknown>)
            : null;
        const outcome = normalizeAgentOutcome(payload?.outcome);
        if (!outcome) continue;
        const outcomeReason = normalizeOutcomeReason(
          payload?.outcomeReason ?? payload?.reason
        );
        const conversationsForSession = conversationIdsBySession.get(sessionId) ?? [];
        for (const conversationId of conversationsForSession) {
          setIfLatest(conversationId, outcome, row.created_at, outcomeReason);
        }
      }
    }
  }

  return new Map(
    Array.from(latestByConversation.entries()).map(([conversationId, item]) => [
      conversationId,
      { outcome: item.outcome, reason: item.reason },
    ])
  );
};

const cleanOutcomeSetting = (value: unknown, maxLength: number) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
};

const parseKeywordSetting = (
  value: unknown,
  maxItems: number,
  maxLength: number,
  fallback: string[]
) => {
  const unique = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const cleaned = item.trim().slice(0, maxLength);
      if (!cleaned) continue;
      unique.add(cleaned.toLowerCase());
      if (unique.size >= maxItems) break;
    }
  }
  return unique.size > 0 ? [...unique] : [...fallback];
};

const clampToInt = (value: unknown, min: number, max: number, fallback: number) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
};

type ResolvedAgentFollowUpPlan = {
  enabled: boolean;
  maxFollowUps: number;
  scheduleHours: number[];
  minDelayMinutes: number;
  maxDelayMinutes: number;
};

const resolveAgentFollowUpPlan = (
  settings?: Record<string, unknown> | null
): ResolvedAgentFollowUpPlan => {
  const source = settings ?? {};
  const fallbackMaxFollowUps = clampToInt(source["maxFollowUps"], 0, 20, 3);
  const fallbackIntervalHours = clampToInt(source["intervalHours"], 0, 720, 24);
  const followUpAutoEnabled =
    typeof source["followUpAutoEnabled"] === "boolean"
      ? Boolean(source["followUpAutoEnabled"])
      : true;
  const rawSchedule = source["followUpScheduleHours"];
  let parsedScheduleHours: number[] = [];
  if (Array.isArray(rawSchedule)) {
    parsedScheduleHours = rawSchedule
      .map((item) => clampToInt(item, 0, 720, Number.NaN))
      .filter((item) => Number.isFinite(item))
      .slice(0, 20);
  }
  const hasExplicitSchedule = parsedScheduleHours.length > 0;
  const maxFollowUps = hasExplicitSchedule
    ? parsedScheduleHours.length
    : fallbackMaxFollowUps;
  const scheduleMinMinutes = hasExplicitSchedule
    ? Math.round(Math.min(...parsedScheduleHours) * 60)
    : Math.round(fallbackIntervalHours * 60);
  const scheduleMaxMinutes = hasExplicitSchedule
    ? Math.round(Math.max(...parsedScheduleHours) * 60)
    : Math.round(fallbackIntervalHours * 60);
  const minDelayMinutes = clampToInt(
    source["followUpDelayMinMinutes"],
    0,
    30 * 24 * 60,
    scheduleMinMinutes
  );
  const maxDelayMinutes = clampToInt(
    source["followUpDelayMaxMinutes"],
    minDelayMinutes,
    30 * 24 * 60,
    scheduleMaxMinutes
  );
  return {
    enabled: followUpAutoEnabled && maxFollowUps > 0,
    maxFollowUps,
    scheduleHours: hasExplicitSchedule ? parsedScheduleHours : [],
    minDelayMinutes,
    maxDelayMinutes,
  };
};

const toIsoPlusMinutes = (baseIso: string, minutes: number) => {
  const base = Date.parse(baseIso);
  const baseMs = Number.isFinite(base) ? base : Date.now();
  const delayMs = Math.max(0, Math.round(minutes)) * 60_000;
  return new Date(baseMs + delayMs).toISOString();
};

const randomIntBetween = (min: number, max: number) => {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const getNextFollowUpAt = (
  baseIso: string,
  plan: ResolvedAgentFollowUpPlan,
  sentCount: number
) => {
  if (!plan.enabled || sentCount < 0 || sentCount >= plan.maxFollowUps) return null;
  const delayMinutes =
    plan.scheduleHours.length > 0
      ? Math.round((plan.scheduleHours[sentCount] ?? 0) * 60)
      : randomIntBetween(plan.minDelayMinutes, plan.maxDelayMinutes);
  return toIsoPlusMinutes(baseIso, delayMinutes);
};

const resetWorkflowAgentFollowUpSchedule = async (input: {
  sessionId: string;
  agentSettings?: Record<string, unknown> | null;
  outboundAt?: string;
}) => {
  const baseIso = input.outboundAt ?? new Date().toISOString();
  const plan = resolveAgentFollowUpPlan(input.agentSettings);
  const nextFollowUpAt = getNextFollowUpAt(baseIso, plan, 0);
  await updateWorkflowAgentSessionFollowUpState(input.sessionId, {
    followUpStep: 0,
    lastFollowUpAt: null,
    nextFollowUpAt,
  });
  return { plan, nextFollowUpAt };
};

const WORKFLOW_AGENT_CONVERSATION_PREFIX = "workflow-agent-session-";
const WORKFLOW_AGENT_CONVERSATIONS_LIMIT = Math.max(
  10,
  Number(process.env.WORKFLOW_AGENT_CONVERSATIONS_LIMIT ?? "60")
);

type WorkflowSessionConversationRow = {
  id: string;
  location_id: string | null;
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  lead_phone_norm: string | null;
  twilio_to_phone: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  updated_at: string | null;
  created_at: string | null;
};

const buildWorkflowAgentConversationId = (sessionId: string) =>
  `${WORKFLOW_AGENT_CONVERSATION_PREFIX}${sessionId}`;

const parseWorkflowAgentSessionIdFromConversationId = (conversationId: string) => {
  if (!conversationId.startsWith(WORKFLOW_AGENT_CONVERSATION_PREFIX)) return null;
  const sessionId = conversationId.slice(WORKFLOW_AGENT_CONVERSATION_PREFIX.length).trim();
  return sessionId || null;
};

const toSafeIso = (value?: string | null) => {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
};

const listWorkflowSessionMessages = async (
  session: WorkflowSessionConversationRow,
  limitPerDirection = 200
) => {
  const supabase = getSupabaseClient();
  if (!supabase) return [];
  const leadPhoneNorm = session.lead_phone_norm ?? normalizePhoneDigits(session.lead_phone);
  if (!leadPhoneNorm) return [];

  const [{ data: outboundRows, error: outboundError }, { data: inboundRows, error: inboundError }] =
    await Promise.all([
      supabase
        .from("sms_events")
        .select("id, to_phone, from_phone, body, created_at")
        .or(`to_phone.ilike.%${leadPhoneNorm}%`)
        .order("created_at", { ascending: false })
        .limit(limitPerDirection),
      supabase
        .from("sms_inbound")
        .select("id, from_phone, to_phone, body, created_at, timestamp")
        .or(`from_phone.ilike.%${leadPhoneNorm}%`)
        .order("created_at", { ascending: false })
        .limit(limitPerDirection),
    ]);
  if (outboundError) throw outboundError;
  if (inboundError) throw inboundError;

  const filteredOutbound = (outboundRows ?? []).filter((item) => {
    const leadMatches = phonesLikelyMatch(item.to_phone, session.lead_phone);
    if (!leadMatches) return false;
    if (!session.twilio_to_phone) return true;
    return phonesLikelyMatch(item.from_phone, session.twilio_to_phone);
  });
  const filteredInbound = (inboundRows ?? []).filter((item) => {
    const leadMatches = phonesLikelyMatch(item.from_phone, session.lead_phone);
    if (!leadMatches) return false;
    if (!session.twilio_to_phone) return true;
    return phonesLikelyMatch(item.to_phone, session.twilio_to_phone);
  });

  const conversationId = buildWorkflowAgentConversationId(session.id);
  const contactId = `workflow-lead-${leadPhoneNorm}`;
  return [
    ...filteredOutbound.map((item) => ({
      id: `workflow-out-${item.id}`,
      conversationId,
      contactId,
      type: "TYPE_SMS",
      direction: "outbound",
      body: String(item.body ?? ""),
      timestamp: toSafeIso(String(item.created_at ?? "")),
    })),
    ...filteredInbound.map((item) => ({
      id: `workflow-in-${item.id}`,
      conversationId,
      contactId,
      type: "TYPE_SMS",
      direction: "inbound",
      body: String(item.body ?? ""),
      timestamp: toSafeIso(
        String((item as { timestamp?: string | null }).timestamp ?? item.created_at ?? "")
      ),
    })),
  ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
};

const paginateChronologicalMessages = <T extends { id: string }>(
  messages: T[],
  limit: number,
  lastMessageId?: string
) => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 20;
  if (messages.length === 0) {
    return { messages: [] as T[], nextPage: false, lastMessageId: undefined as string | undefined };
  }
  if (!lastMessageId) {
    const page = messages.slice(-safeLimit);
    const nextPage = messages.length > safeLimit;
    return {
      messages: page,
      nextPage,
      lastMessageId: nextPage ? page[0]?.id : undefined,
    };
  }

  const boundaryIndex = messages.findIndex((message) => message.id === lastMessageId);
  const endIndex = boundaryIndex >= 0 ? boundaryIndex : messages.length;
  const startIndex = Math.max(0, endIndex - safeLimit);
  const page = messages.slice(startIndex, endIndex);
  const nextPage = startIndex > 0;
  return {
    messages: page,
    nextPage,
    lastMessageId: nextPage ? page[0]?.id : undefined,
  };
};

const listWorkflowAgentConversationsForLocation = async (input: {
  locationId?: string;
  inboundOnly: boolean;
}) => {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  let sessionsQuery = supabase
    .from("workflow_agent_sessions")
    .select(
      "id, location_id, lead_name, lead_email, lead_phone, lead_phone_norm, twilio_to_phone, last_inbound_at, last_outbound_at, updated_at, created_at"
    )
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(WORKFLOW_AGENT_CONVERSATIONS_LIMIT);

  if (input.locationId) {
    sessionsQuery = sessionsQuery.eq("location_id", input.locationId);
  }

  const { data: sessionRows, error: sessionError } = await sessionsQuery;
  if (sessionError) throw sessionError;

  const mapped = await Promise.all(
    ((sessionRows ?? []) as WorkflowSessionConversationRow[]).map(async (session) => {
      const messages = await listWorkflowSessionMessages(session, 80);
      const hasInbound = messages.some((item) =>
        String(item.direction ?? "").toLowerCase().includes("inbound")
      );
      if (input.inboundOnly && !hasInbound) {
        return null;
      }
      const lastMessage = messages[messages.length - 1];
      if (!lastMessage) {
        return null;
      }
      const lastInboundMs = Date.parse(session.last_inbound_at ?? "");
      const lastOutboundMs = Date.parse(session.last_outbound_at ?? "");
      const unreadCount =
        Number.isFinite(lastInboundMs) &&
        (!Number.isFinite(lastOutboundMs) || lastInboundMs >= lastOutboundMs)
          ? 1
          : 0;

      return {
        id: buildWorkflowAgentConversationId(session.id),
        channel: "SMS",
        contactName:
          session.lead_name?.trim() ||
          session.lead_email?.split("@")[0] ||
          session.lead_phone,
        contactEmail: session.lead_email ?? undefined,
        contactPhone: session.lead_phone ?? undefined,
        lastMessageBody: lastMessage.body ?? "",
        lastMessageDate:
          lastMessage.timestamp ??
          toSafeIso(session.updated_at ?? session.last_inbound_at ?? session.created_at),
        unreadCount,
        pipelineStageName: "Workflow Agent",
        source: "workflow_agent",
      };
    })
  );

  return mapped
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => {
      const aTime = Date.parse(a.lastMessageDate ?? "") || 0;
      const bTime = Date.parse(b.lastMessageDate ?? "") || 0;
      return bTime - aTime;
    });
};

const resolveAgentOutcomeSettings = (settings?: Record<string, unknown> | null) => {
  const source = settings ?? {};
  return {
    autoMarkOutcomes:
      typeof source["autoMarkOutcomes"] === "boolean"
        ? Boolean(source["autoMarkOutcomes"])
        : true,
    salesHandoverStage:
      cleanOutcomeSetting(source["salesHandoverStage"], 120) ?? "Sales Overdracht",
    reviewNeededStage:
      cleanOutcomeSetting(source["reviewNeededStage"], 120) ?? "Review Nodig",
    lostStage: cleanOutcomeSetting(source["lostStage"], 120) ?? "Lost",
    lostDecisionPrompt: cleanOutcomeSetting(source["lostDecisionPrompt"], 4000),
    lostKeywords: parseKeywordSetting(source["lostKeywords"], 40, 120, DEFAULT_LOST_KEYWORDS),
  };
};

const toNormalizedText = (value?: string | null) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const buildLostConversationContext = (messages?: OutcomeMessage[]) => {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const rows = messages
    .filter((msg) => String(msg.body ?? "").trim().length > 0)
    .slice(-14)
    .map((msg) => {
      const direction = toNormalizedText(msg.direction);
      const role = direction.includes("in") ? "Lead" : direction.includes("out") ? "Agent" : "Onbekend";
      const subject = String(msg.subject ?? "").trim();
      const body = String(msg.body ?? "").replace(/\s+/g, " ").trim();
      const timestamp = String(msg.timestamp ?? "").trim();
      const subjectBlock = subject ? `Onderwerp: ${subject} | ` : "";
      const timeBlock = timestamp ? `${timestamp} ` : "";
      return `${timeBlock}[${role}] ${subjectBlock}${body.slice(0, 420)}`;
    });
  return rows.join("\n");
};

const resolveOutcomeFromSuggestion = async (input: {
  policy?: AgentPolicyMeta;
  lastInboundText?: string;
  messages?: OutcomeMessage[];
  settings?: Record<string, unknown> | null;
}): Promise<{ outcome: AgentOutcomeType; stageName: string; reason: string } | null> => {
  const settings = resolveAgentOutcomeSettings(input.settings);
  if (!settings.autoMarkOutcomes) return null;

  const conversationContext = buildLostConversationContext(input.messages);
  const lostDecision = await classifyLostDraft({
    text: input.lastInboundText,
    conversationContext,
    lostDecisionPrompt: settings.lostDecisionPrompt,
    keywordHints: settings.lostKeywords,
  });
  if (lostDecision.isLost) {
    const reason = lostDecision.reason?.trim();
    return {
      outcome: "lost",
      stageName: settings.lostStage,
      reason: reason ? `lost_ai:${reason.slice(0, 120)}` : "lost_ai",
    };
  }

  const handoffRequired = Boolean(input.policy?.handoffRequired);
  if (handoffRequired) {
    return {
      outcome: "sales_handover",
      stageName: settings.salesHandoverStage,
      reason: input.policy?.handoffReason?.trim() || "handoff_required",
    };
  }

  const needsReview =
    Boolean(input.policy?.followUpLimitReached) ||
    (Array.isArray(input.policy?.safetyFlags) && input.policy!.safetyFlags!.length > 0);
  if (needsReview) {
    const safetyReason =
      Array.isArray(input.policy?.safetyFlags) && input.policy!.safetyFlags!.length > 0
        ? `safety:${String(input.policy!.safetyFlags![0])}`
        : undefined;
    return {
      outcome: "review_needed",
      stageName: settings.reviewNeededStage,
      reason: safetyReason ?? "review_required",
    };
  }

  return null;
};

const resolveContactIdByPhone = async (config: GhlConfig, phone?: string | null) => {
  if (!phone?.trim()) return null;
  const search = await searchContacts(config, phone.trim()).catch(() => null);
  const match = search?.contacts?.find((contact) => phonesLikelyMatch(contact.phone, phone));
  return match?.id ?? null;
};

const resolveContactIdByEmail = async (config: GhlConfig, email?: string | null) => {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  const search = await searchContacts(config, normalized).catch(() => null);
  const match = search?.contacts?.find(
    (contact) => String(contact.email ?? "").trim().toLowerCase() === normalized
  );
  return match?.id ?? null;
};

const resolveWorkflowLeadContactId = async (input: {
  config: GhlConfig;
  explicitContactId?: string | null;
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  preferredChannel?: "SMS" | "EMAIL";
}) => {
  const explicit = input.explicitContactId?.trim();
  if (explicit) return explicit;
  const lookupOrder =
    input.preferredChannel === "EMAIL"
      ? (["email", "phone"] as const)
      : (["phone", "email"] as const);
  for (const key of lookupOrder) {
    const candidate =
      key === "phone"
        ? await resolveContactIdByPhone(input.config, input.phone)
        : await resolveContactIdByEmail(input.config, input.email);
    if (candidate) return candidate;
  }
  const byNameQuery = input.name?.trim();
  if (!byNameQuery) return null;
  const search = await searchContacts(input.config, byNameQuery).catch(() => null);
  const normalizedName = byNameQuery.toLowerCase();
  const byName = search?.contacts?.find((contact) => {
    const full = [contact.firstName, contact.lastName]
      .filter(Boolean)
      .join(" ")
      .trim()
      .toLowerCase();
    return full === normalizedName;
  });
  return byName?.id ?? null;
};

const selectConversationForContact = async (input: {
  config: GhlConfig;
  contactId: string;
  channel: "SMS" | "EMAIL";
  explicitConversationId?: string | null;
}) => {
  const explicit = input.explicitConversationId?.trim();
  if (explicit) return explicit;
  const conversations = await listConversationsPaged(input.config, {
    contactId: input.contactId,
    pageLimit: 20,
    maxPages: 3,
  }).catch(() => []);
  const preferred = conversations.find((conversation) => {
    const lower = String(conversation.channel ?? "").toLowerCase();
    if (input.channel === "SMS") return lower.includes("sms");
    return lower.includes("email");
  });
  return preferred?.id ?? conversations[0]?.id ?? null;
};

const sendWorkflowMessageViaGhl = async (input: {
  resolvedLocationId?: string;
  channel: "SMS" | "EMAIL";
  body: string;
  subject?: string;
  lead?: {
    name?: string;
    email?: string;
    phone?: string;
    contactId?: string;
    conversationId?: string;
  };
}) => {
  const locationId = input.resolvedLocationId?.trim();
  if (!locationId) {
    throw new Error("Workflow messaging via GHL vereist een geldige subaccount/locationId.");
  }
  const config = getGhlConfig(locationId);
  const contactId = await resolveWorkflowLeadContactId({
    config,
    explicitContactId: input.lead?.contactId,
    phone: input.lead?.phone,
    email: input.lead?.email,
    name: input.lead?.name,
    preferredChannel: input.channel,
  });
  if (!contactId) {
    throw new Error("Lead contact niet gevonden in GHL. Controleer telefoon/email/contactId.");
  }
  const conversationId = await selectConversationForContact({
    config,
    contactId,
    channel: input.channel,
    explicitConversationId: input.lead?.conversationId,
  });
  const result = await sendMessage(config, {
    contactId,
    ...(conversationId ? { conversationId } : {}),
    channel: input.channel,
    body: input.body,
    ...(input.channel === "EMAIL"
      ? { subject: input.subject?.trim() || "Opvolging" }
      : {}),
    locationId: config.locationId,
  });
  return {
    provider: "ghl",
    channel: input.channel,
    contactId,
    conversationId: conversationId ?? undefined,
    providerMessageId: result.messageId ?? result.emailMessageId,
    messageId: result.messageId,
    emailMessageId: result.emailMessageId,
  };
};

const maybeMarkOpportunityStageFromAgentOutcome = async (input: {
  config: GhlConfig;
  contactId?: string | null;
  leadPhone?: string | null;
  leadEmail?: string | null;
  policy?: AgentPolicyMeta;
  lastInboundText?: string;
  messages?: OutcomeMessage[];
  agentSettings?: Record<string, unknown> | null;
}) => {
  const resolved = await resolveOutcomeFromSuggestion({
    policy: input.policy,
    lastInboundText: input.lastInboundText,
    messages: input.messages,
    settings: input.agentSettings,
  });
  if (!resolved) {
    return { marked: false as const, reason: "no_outcome" as const };
  }

  const contactId =
    input.contactId?.trim() ||
    (await resolveContactIdByPhone(input.config, input.leadPhone ?? undefined)) ||
    (await resolveContactIdByEmail(input.config, input.leadEmail ?? undefined));
  if (!contactId) {
    return {
      marked: false as const,
      reason: "contact_not_found" as const,
      stageName: resolved.stageName,
      outcome: resolved.outcome,
      outcomeReason: resolved.reason,
    };
  }

  const result = await updateLatestOpportunityStageByName({
    config: input.config,
    contactId,
    stageName: resolved.stageName,
  });

  return {
    marked: result.updated,
    reason: result.updated ? "stage_updated" : result.reason,
    contactId,
    stageName: resolved.stageName,
    outcome: resolved.outcome,
    outcomeReason: resolved.reason,
    opportunityId: result.updated ? result.opportunityId : undefined,
  };
};

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/locations", (_req, res) => {
  const locations = getAccountEntries().map(({ id, name }) => ({ id, name }));
  res.json({ locations });
});

app.get("/api/ghl/stages", async (req, res, next) => {
  try {
    const locationId = req.query.locationId as string | undefined;
    const config = getGhlConfig(locationId);
    const stageMap = await getPipelineStageMap(config).catch(() => new Map());
    const stages = Array.from(new Set(Array.from(stageMap.values())))
      .map((stage) => stage?.trim())
      .filter((stage): stage is string => Boolean(stage))
      .sort((a, b) => a.localeCompare(b, "nl-BE"));
    res.json({ stages });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ghl/leads", async (req, res, next) => {
  try {
    const locationId = req.query.locationId as string | undefined;
    const rawQuery = String(req.query.q ?? "").trim();
    const q = rawQuery && rawQuery !== "*" ? rawQuery : "a";
    const searchAfter = req.query.searchAfter as string | undefined;
    const config = getGhlConfig(locationId);
    const result = await searchContacts(config, q, searchAfter);
    let stageMap = new Map<string, string>();
    try {
      stageMap = await getPipelineStageMap(config);
    } catch {
      stageMap = new Map();
    }
    const contacts = await Promise.all(
      result.contacts.map(async (contact) => {
        try {
          const [stage, details] = await Promise.all([
            getLatestOpportunityStage(config, contact.id).catch(() => null),
            getContactById(config, contact.id).catch(() => null),
          ]);

          const pipelineStageName =
            stage?.pipelineStageName ??
            (stage?.pipelineStageId
              ? stageMap.get(stage.pipelineStageId)
              : undefined);

          return {
            ...contact,
            pipelineStageName,
            postalCode: details?.postalCode ?? undefined,
            city: details?.city ?? undefined,
            source: details?.source ?? undefined,
          };
        } catch {
          return contact;
        }
      })
    );

    res.json({ contacts, searchAfter: result.searchAfter });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ghl/opportunities", async (req, res, next) => {
  try {
    const locationId = req.query.locationId as string | undefined;
    const rawQuery = String(req.query.q ?? "").trim();
    const q = rawQuery && rawQuery !== "*" ? rawQuery : undefined;
    const rawStage = String(req.query.stage ?? "").trim();
    const stageFilter = rawStage ? normalizeStage(rawStage) : undefined;
    const searchAfter = req.query.searchAfter as string | undefined;
    const config = getGhlConfig(locationId);
    const stageMap = await getPipelineStageMap(config).catch(() => new Map());

    let baseList = [] as Awaited<ReturnType<typeof listOpportunities>>["opportunities"];
    let nextSearchAfter = searchAfter;

    if (stageFilter) {
      const aggregated: typeof baseList = [];
      let cursor = searchAfter;

      for (let page = 0; page < OPPORTUNITY_STAGE_SCAN_MAX_PAGES; page += 1) {
        const list = await listOpportunities(config, {
          limit: 100,
          searchAfter: cursor,
          query: q,
        });
        aggregated.push(
          ...list.opportunities.filter(
            (item) =>
              normalizeStage(
                item.pipelineStageName ??
                  (item.pipelineStageId ? stageMap.get(item.pipelineStageId) : undefined)
              ) === stageFilter
          )
        );

        if (!list.searchAfter) {
          cursor = undefined;
          break;
        }

        cursor = list.searchAfter;
        if (aggregated.length >= 50) {
          break;
        }
      }

      baseList = aggregated;
      nextSearchAfter = cursor;
    } else {
      const list = await listOpportunities(config, {
        limit: 50,
        searchAfter,
        query: q,
      });
      baseList = list.opportunities;
      nextSearchAfter = list.searchAfter;
    }

    const opportunities = await Promise.all(
      baseList.map(async (item) => {
        if (!item.contactId) return item;
        const details = await getContactById(config, item.contactId).catch(
          () => null
        );
        const pipelineStageName =
          item.pipelineStageName ??
          (item.pipelineStageId
            ? stageMap.get(item.pipelineStageId)
            : undefined);

        return {
          ...item,
          pipelineStageName,
          contactName: details
            ? [details.firstName, details.lastName].filter(Boolean).join(" ")
            : undefined,
          contactEmail: details?.email ?? undefined,
          contactPhone: details?.phone ?? undefined,
          postalCode: details?.postalCode ?? undefined,
          city: details?.city ?? undefined,
          source: details?.source ?? undefined,
          dateAdded: details?.dateAdded ?? undefined,
        };
      })
    );

    res.json({ opportunities, searchAfter: nextSearchAfter });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ghl/opportunities/stats", async (req, res, next) => {
  try {
    const locationId = req.query.locationId as string | undefined;
    const rawQuery = String(req.query.q ?? "").trim();
    const q = rawQuery && rawQuery !== "*" ? rawQuery : undefined;
    const force = req.query.force === "true";
    const config = getGhlConfig(locationId);
    const stageMap = await getPipelineStageMap(config).catch(() => new Map());
    const cacheKey = `${config.locationId}::${q ?? ""}`;
    const now = Date.now();

    if (!force) {
      const cached = opportunityStatsCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        res.json(cached.payload);
        return;
      }
    }

    const byStage: Record<string, number> = {};
    let total = 0;
    let searchAfter: string | undefined = undefined;
    let partial = false;

    for (let page = 0; page < OPPORTUNITY_STATS_MAX_PAGES; page += 1) {
      const list = await listOpportunities(config, {
        limit: 100,
        searchAfter,
        query: q,
      });

      for (const item of list.opportunities) {
        total += 1;
        const stage = displayStage(
          item.pipelineStageName ??
            (item.pipelineStageId ? stageMap.get(item.pipelineStageId) : undefined)
        );
        byStage[stage] = (byStage[stage] ?? 0) + 1;
      }

      if (!list.searchAfter) {
        searchAfter = undefined;
        break;
      }

      searchAfter = list.searchAfter;
    }

    if (searchAfter) {
      partial = true;
    }

    const payload: OpportunityStatsPayload = {
      total,
      byStage,
      cachedAt: new Date().toISOString(),
      partial,
    };

    opportunityStatsCache.set(cacheKey, {
      expiresAt: now + OPPORTUNITY_STATS_TTL_MS,
      payload,
    });

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.post("/api/contacts/search", async (req, res, next) => {
  const schema = z.object({
    query: z.string().min(1),
    searchAfter: z.string().optional(),
    locationId: z.string().optional(),
  });

  try {
    const body = schema.parse(req.body);
    const config = getGhlConfig(body.locationId);
    const result = await searchContacts(config, body.query, body.searchAfter);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/contacts/:contactId/conversations", async (req, res, next) => {
  try {
    const { contactId } = req.params;
    const locationId = req.query.locationId as string | undefined;
    const inboundOnly = req.query.inboundOnly === "true";
    const config = getGhlConfig(locationId);
    const conversations = await listConversations(config, contactId);
    if (inboundOnly) {
      const filtered = await filterConversationsWithInbound(
        config,
        conversations,
        conversations.length || 0
      );
      res.json({ conversations: filtered });
      return;
    }
    res.json({ conversations });
  } catch (error) {
    next(error);
  }
});

app.get("/api/conversations/recent", async (req, res, next) => {
  try {
    const locationId = req.query.locationId as string | undefined;
    const inboundOnly = req.query.inboundOnly === "true";
    const config = getGhlConfig(locationId);
    const allGhlConversations = await listConversationsPaged(config, {
      pageLimit: CONVERSATIONS_PAGE_LIMIT,
      maxPages: CONVERSATIONS_MAX_PAGES,
    });
    const conversations = inboundOnly
      ? await filterConversationsWithInbound(
          config,
          allGhlConversations,
          allGhlConversations.length || 0
        )
      : allGhlConversations;
    const stageMap = await getPipelineStageMap(config).catch(() => new Map());

    const opportunityByContact = new Map<
      string,
      { stage?: string; updatedAt?: string; createdAt?: string }
    >();

    let opportunityCursor: string | undefined = undefined;
    for (
      let page = 0;
      page < CONVERSATIONS_OPPORTUNITY_MAX_PAGES;
      page += 1
    ) {
      const opportunityList = await listOpportunities(config, {
        limit: 100,
        searchAfter: opportunityCursor,
      });

      opportunityList.opportunities.forEach((item) => {
        if (!item.contactId) return;
        const stage =
          item.pipelineStageName ??
          (item.pipelineStageId ? stageMap.get(item.pipelineStageId) : undefined);
        const updated = item.updatedAt ?? item.createdAt;
        const existing = opportunityByContact.get(item.contactId);
        if (!existing) {
          opportunityByContact.set(item.contactId, {
            stage,
            updatedAt: updated,
            createdAt: item.createdAt,
          });
          return;
        }
        const existingTime = Date.parse(existing.updatedAt ?? "") || 0;
        const newTime = Date.parse(updated ?? "") || 0;
        if (newTime >= existingTime) {
          opportunityByContact.set(item.contactId, {
            stage,
            updatedAt: updated,
            createdAt: item.createdAt,
          });
        }
      });

      if (!opportunityList.searchAfter) {
        opportunityCursor = undefined;
        break;
      }
      opportunityCursor = opportunityList.searchAfter;
    }

    const enrichedGhlConversations = await Promise.all(
      conversations.map(async (conversation) => {
        if (!conversation.contactId) return conversation;
        const details = await getContactById(config, conversation.contactId).catch(
          () => null
        );

        const contactName = details
          ? [details.firstName, details.lastName].filter(Boolean).join(" ")
          : undefined;
        const stage = opportunityByContact.get(conversation.contactId);

        return {
          ...conversation,
          contactName: contactName || undefined,
          contactEmail: details?.email ?? undefined,
          contactPhone: details?.phone ?? undefined,
          pipelineStageName: stage?.stage,
        };
      })
    );
    const workflowConversations = await listWorkflowAgentConversationsForLocation({
      locationId: config.locationId,
      inboundOnly,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Onbekende fout";
      console.error("Workflow conversations ophalen mislukt:", message);
      return [];
    });

    const merged = [...enrichedGhlConversations, ...workflowConversations].sort((a, b) => {
      const aTime = Date.parse((a as { lastMessageDate?: string }).lastMessageDate ?? "") || 0;
      const bTime = Date.parse((b as { lastMessageDate?: string }).lastMessageDate ?? "") || 0;
      return bTime - aTime;
    });

    const conversationIds = Array.from(
      new Set(
        merged
          .map((conversation) =>
            typeof conversation?.id === "string" ? conversation.id.trim() : ""
          )
          .filter(Boolean)
      )
    );
    const outcomeByConversation = await resolveConversationOutcomeMap({
      locationId: config.locationId,
      conversationIds,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Onbekende fout";
      console.error("Conversation outcomes ophalen mislukt:", message);
      return new Map<string, { outcome: AgentOutcomeType; reason?: string }>();
    });
    const conversationsWithOutcome = merged.map((conversation) => {
      const outcomeMeta = outcomeByConversation.get(String(conversation.id ?? "").trim());
      return {
        ...conversation,
        agentOutcome: outcomeMeta?.outcome,
        agentOutcomeReason: outcomeMeta?.reason,
      };
    });

    res.json({ conversations: conversationsWithOutcome });
  } catch (error) {
    next(error);
  }
});

app.get("/api/conversations/:conversationId/messages", async (req, res, next) => {
  const schema = z.object({
    limit: z.string().optional(),
    lastMessageId: z.string().optional(),
    locationId: z.string().optional(),
  });

  try {
    const { conversationId } = req.params;
    const query = schema.parse(req.query);
    const limit = query.limit ? Number(query.limit) : 20;
    const workflowSessionId =
      parseWorkflowAgentSessionIdFromConversationId(conversationId);
    if (workflowSessionId) {
      const supabase = getSupabaseClient();
      if (!supabase) {
        res.status(500).json({ error: "Supabase not configured." });
        return;
      }
      const { data: session, error: sessionError } = await supabase
        .from("workflow_agent_sessions")
        .select(
          "id, location_id, lead_name, lead_email, lead_phone, lead_phone_norm, twilio_to_phone, last_inbound_at, last_outbound_at, updated_at, created_at"
        )
        .eq("id", workflowSessionId)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (!session) {
        res.status(404).json({ error: "Conversation niet gevonden." });
        return;
      }
      const messages = await listWorkflowSessionMessages(
        session as WorkflowSessionConversationRow,
        600
      );
      const page = paginateChronologicalMessages(messages, limit, query.lastMessageId);
      res.json(page);
      return;
    }

    const config = getGhlConfig(query.locationId);
    const page = await listMessages(config, conversationId, limit, query.lastMessageId);
    res.json(page);
  } catch (error) {
    next(error);
  }
});

app.get("/api/contacts/:contactId", async (req, res, next) => {
  try {
    const { contactId } = req.params;
    const locationId = req.query.locationId as string | undefined;
    const config = getGhlConfig(locationId);
    const contact = await getContactById(config, contactId);
    res.json({ contact });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sync", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    full: z.boolean().optional(),
    createDrafts: z.boolean().optional(),
  });
  try {
    const body = schema.parse(req.body ?? {});
    const result = body.full
      ? await syncNowWithOptions(body.locationId, {
          full: true,
          createDrafts: body.createDrafts,
        })
      : await syncNow(body.locationId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/kpis", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { data, error } = await supabase.from("dashboard_kpis").select("*");
    if (error) throw error;
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/daily", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { data, error } = await supabase.from("dashboard_daily_volume").select("*");
    if (error) throw error;
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/usage", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const rawInput = Number(process.env.OPENAI_PRICE_INPUT_PER_1M ?? "0.15");
    const rawOutput = Number(process.env.OPENAI_PRICE_OUTPUT_PER_1M ?? "0.60");
    const rawFx = Number(process.env.USD_TO_EUR_RATE ?? "0.92");
    const priceInputPer1M = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0.15;
    const priceOutputPer1M = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0.60;
    const usdToEur = Number.isFinite(rawFx) && rawFx > 0 ? rawFx : 0.92;
    const blendedPer1M = (priceInputPer1M + priceOutputPer1M) / 2;

    const { data, error } = await supabase
      .from("drafts")
      .select("tokens, cost_eur");
    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    const tokensTotal = rows.reduce(
      (sum, row) => sum + Number((row as { tokens?: number }).tokens ?? 0),
      0
    );
    const costTotal = rows.reduce(
      (sum, row) => sum + Number((row as { cost_eur?: number }).cost_eur ?? 0),
      0
    );
    const estimated = tokensTotal
      ? (tokensTotal * blendedPer1M) / 1_000_000 * usdToEur
      : 0;
    const useEstimated =
      tokensTotal > 0 && (costTotal <= 0 || costTotal < estimated * 0.5);

    res.json({
      tokensTotal,
      costTotal: useEstimated ? estimated : costTotal,
      estimated: useEstimated,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/drafts", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const rawInput = Number(process.env.OPENAI_PRICE_INPUT_PER_1M ?? "0.15");
    const rawOutput = Number(process.env.OPENAI_PRICE_OUTPUT_PER_1M ?? "0.60");
    const rawFx = Number(process.env.USD_TO_EUR_RATE ?? "0.92");
    const priceInputPer1M = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0.15;
    const priceOutputPer1M = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0.60;
    const usdToEur = Number.isFinite(rawFx) && rawFx > 0 ? rawFx : 0.92;
    const blendedPer1M = (priceInputPer1M + priceOutputPer1M) / 2;
    const { data: overview, error: overviewError } = await supabase
      .from("drafts_overview")
      .select("*")
      .order("draft_created_at", { ascending: false })
      .limit(50);
    if (overviewError) {
      const { data, error } = await supabase
        .from("dashboard_drafts_recent")
        .select("*")
        .limit(50);
      if (error) throw error;
      res.json({ data });
      return;
    }
    const data = (overview ?? []).map((row: { cost_eur?: number | null; tokens?: number | null }) => {
      const tokens = Number(row.tokens ?? 0);
      const current = Number(row.cost_eur ?? 0);
      if (tokens > 0) {
        const estimated = (tokens * blendedPer1M) / 1_000_000 * usdToEur;
        if (!Number.isFinite(current) || current <= 0 || current < estimated * 0.5) {
          return { ...row, cost_eur: Number.isFinite(estimated) ? estimated : row.cost_eur };
        }
      }
      return row;
    });
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/lost-drafts", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const rawInput = Number(process.env.OPENAI_PRICE_INPUT_PER_1M ?? "0.15");
    const rawOutput = Number(process.env.OPENAI_PRICE_OUTPUT_PER_1M ?? "0.60");
    const rawFx = Number(process.env.USD_TO_EUR_RATE ?? "0.92");
    const priceInputPer1M = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0.15;
    const priceOutputPer1M = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0.60;
    const usdToEur = Number.isFinite(rawFx) && rawFx > 0 ? rawFx : 0.92;
    const blendedPer1M = (priceInputPer1M + priceOutputPer1M) / 2;

    const { data: overview, error: overviewError } = await supabase
      .from("dashboard_lost_drafts_recent")
      .select("*")
      .order("lost_created_at", { ascending: false })
      .limit(50);
    if (overviewError) {
      const { data, error } = await supabase
        .from("lost_drafts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      res.json({ data });
      return;
    }

    const data = (overview ?? []).map((row: { cost_eur?: number | null; tokens?: number | null }) => {
      const tokens = Number(row.tokens ?? 0);
      const current = Number(row.cost_eur ?? 0);
      if (tokens > 0) {
        const estimated = (tokens * blendedPer1M) / 1_000_000 * usdToEur;
        if (!Number.isFinite(current) || current <= 0 || current < estimated * 0.5) {
          return { ...row, cost_eur: Number.isFinite(estimated) ? estimated : row.cost_eur };
        }
      }
      return row;
    });
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dns", async (req, res, next) => {
  const schema = z.object({
    provider: z.string().optional(),
    domain: z.string().min(1),
    txtRecords: z.array(z.object({ name: z.string(), value: z.string() })),
    mxRecords: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
        priority: z.string(),
      })
    ),
    cname: z.object({ name: z.string(), value: z.string() }),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const body = schema.parse(req.body);
    const txtRecords = body.txtRecords.filter(
      (record) => record.name.trim() && record.value.trim()
    );
    const mxRecords = body.mxRecords.filter(
      (record) => record.name.trim() && record.value.trim() && record.priority.trim()
    );
    const cnameRecord =
      body.cname.name.trim() && body.cname.value.trim() ? body.cname : null;
    const { error } = await supabase.from("dns_records").insert({
      provider: body.provider ?? "mailgun",
      domain: body.domain,
      txt_records: txtRecords,
      mx_records: mxRecords,
      cname_record: cnameRecord,
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/twilio/send", async (req, res, next) => {
  const schema = z.object({
    to: z.string().min(3),
    body: z.string().min(1),
  });
  try {
    const payload = schema.parse(req.body);
    const result = await sendSmsViaTwilio({ to: payload.to, body: payload.body });
    res.json({ success: true, sid: result.sid, status: result.status });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mailgun/send", async (req, res, next) => {
  const schema = z.object({
    to: z.string().min(3),
    subject: z.string().min(1),
    text: z.string().min(1),
  });
  try {
    const body = schema.parse(req.body);
    const result = await sendEmailViaMailgun({
      to: body.to,
      subject: body.subject,
      text: body.text,
    });
    res.json({ success: true, id: result.id, message: result.message });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflows", async (_req, res, next) => {
  try {
    const workflows = await listWorkflows();
    res.json({ workflows });
  } catch (error) {
    next(error);
  }
});

const toPeriodStart = (range: "today" | "7d" | "30d") => {
  const now = new Date();
  if (range === "today") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  if (range === "30d") {
    return new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  }
  return new Date(now.getTime() - 7 * 24 * 60 * 60_000);
};

const toLeadIdentityKey = (lead: { lead_phone?: string | null; lead_email?: string | null; lead_name?: string | null }) => {
  const phoneNorm = normalizePhoneDigits(lead.lead_phone);
  if (phoneNorm) return `phone:${phoneNorm}`;
  const email = String(lead.lead_email ?? "")
    .trim()
    .toLowerCase();
  if (email) return `email:${email}`;
  const name = String(lead.lead_name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (name) return `name:${name}`;
  return undefined;
};

const parseStepOutput = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
};

const isWorkflowStepMessageSent = (step: { node_type?: string | null; output?: unknown }) => {
  const type = String(step.node_type ?? "");
  if (type !== "action.sms" && type !== "action.email" && type !== "action.agent") {
    return false;
  }
  const output = parseStepOutput(step.output);
  if (output.skipped === true) return false;
  if (type === "action.agent") {
    const delivery =
      output.delivery && typeof output.delivery === "object"
        ? (output.delivery as Record<string, unknown>)
        : null;
    if (!delivery) return false;
    if (delivery.status === "skipped") return false;
  }
  return true;
};

const splitCurrentPrevious = <T extends { created_at?: string | null }>(
  rows: T[],
  currentStartMs: number,
  previousStartMs: number
) => {
  const current: T[] = [];
  const previous: T[] = [];
  for (const row of rows) {
    const ts = Date.parse(String(row.created_at ?? ""));
    if (!Number.isFinite(ts)) continue;
    if (ts >= currentStartMs) {
      current.push(row);
      continue;
    }
    if (ts >= previousStartMs && ts < currentStartMs) {
      previous.push(row);
    }
  }
  return { current, previous };
};

const toWorkflowSessionIdFromConversationId = (value?: string | null) => {
  const raw = String(value ?? "");
  const prefix = "workflow-agent-session-";
  if (!raw.startsWith(prefix)) return undefined;
  const sessionId = raw.slice(prefix.length).trim();
  return sessionId || undefined;
};

const chunkArray = <T,>(items: T[], size: number) => {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const compactJoin = (parts: Array<string | null | undefined>, separator = " · ") =>
  parts.map((value) => String(value ?? "").trim()).filter(Boolean).join(separator);

const toLeadTitle = (lead?: { lead_name?: string | null; lead_email?: string | null; lead_phone?: string | null }) => {
  const leadName = String(lead?.lead_name ?? "").trim();
  if (leadName) return leadName;
  const email = String(lead?.lead_email ?? "").trim();
  if (email) return email;
  const phone = String(lead?.lead_phone ?? "").trim();
  if (phone) return phone;
  return "Onbekende lead";
};

const getDashboardLeadSnapshot = async (input: {
  config: GhlConfig;
  range: "today" | "7d" | "30d";
  currentStartMs: number;
  previousStartMs: number;
}) => {
  const cacheKey = `${input.config.locationId}::${input.range}`;
  const now = Date.now();
  const cached = dashboardLeadSnapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.payload;
  }

  let total = 0;
  let current = 0;
  let previous = 0;
  let scanned = 0;
  let partial = false;
  let searchAfter: string | undefined = undefined;

  for (let page = 0; page < OPPORTUNITY_STATS_MAX_PAGES; page += 1) {
    const list = await listOpportunities(input.config, {
      limit: 100,
      searchAfter,
    });
    scanned += list.opportunities.length;

    for (const opportunity of list.opportunities) {
      total += 1;
      const ts = Date.parse(String(opportunity.createdAt ?? opportunity.updatedAt ?? ""));
      if (!Number.isFinite(ts)) continue;
      if (ts >= input.currentStartMs) {
        current += 1;
        continue;
      }
      if (ts >= input.previousStartMs && ts < input.currentStartMs) {
        previous += 1;
      }
    }

    if (!list.searchAfter) {
      searchAfter = undefined;
      break;
    }
    searchAfter = list.searchAfter;
  }

  if (searchAfter) partial = true;

  const payload: DashboardLeadSnapshotPayload = {
    total,
    current,
    previous,
    scanned,
    partial,
    cachedAt: new Date().toISOString(),
  };
  dashboardLeadSnapshotCache.set(cacheKey, {
    expiresAt: now + OPPORTUNITY_STATS_TTL_MS,
    payload,
  });
  return payload;
};

app.get("/api/dashboard/overview", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    range: z.enum(["today", "7d", "30d"]).optional(),
  });
  try {
    const query = schema.parse(req.query);
    const range = query.range ?? "7d";
    const config = getGhlConfig(query.locationId);
    const resolvedLocationId = config.locationId;

    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }

    const currentStart = toPeriodStart(range);
    const periodMs = Date.now() - currentStart.getTime();
    const previousStart = new Date(currentStart.getTime() - periodMs);
    const currentStartIso = currentStart.toISOString();
    const previousStartIso = previousStart.toISOString();
    const currentStartMs = currentStart.getTime();
    const previousStartMs = previousStart.getTime();
    const leadSnapshotPromise = getDashboardLeadSnapshot({
      config,
      range,
      currentStartMs,
      previousStartMs,
    });

    const enrollmentsQuery = supabase
      .from("workflow_enrollments")
      .select("id, location_id, lead_name, lead_email, lead_phone, created_at")
      .gte("created_at", previousStartIso)
      .order("created_at", { ascending: false })
      .limit(5000);
    const enrollmentsAllTimeQuery = supabase
      .from("workflow_enrollments")
      .select("location_id, lead_name, lead_email, lead_phone, created_at")
      .order("created_at", { ascending: false })
      .limit(20000);
    const sessionsQuery = supabase
      .from("workflow_agent_sessions")
      .select("id, location_id, lead_name, lead_phone, lead_phone_norm, created_at, activated_at, updated_at")
      .gte("updated_at", previousStartIso)
      .order("updated_at", { ascending: false })
      .limit(5000);
    const eventsQuery = supabase
      .from("workflow_agent_events")
      .select("id, session_id, event_type, created_at")
      .gte("created_at", previousStartIso)
      .order("created_at", { ascending: false })
      .limit(10000);
    const agentRunsQuery = supabase
      .from("ai_agent_runs")
      .select("id, location_id, source, conversation_id, handoff_required, handoff_reason, follow_up_limit_reached, safety_flags, created_at")
      .gte("created_at", previousStartIso)
      .order("created_at", { ascending: false })
      .limit(10000);

    const [enrollmentsRows, enrollmentsAllTimeRows, sessionsRows, eventsRows, agentRunsRows, leadSnapshot] = await Promise.all([
      enrollmentsQuery,
      enrollmentsAllTimeQuery,
      sessionsQuery,
      eventsQuery,
      agentRunsQuery,
      leadSnapshotPromise,
    ]);
    if (enrollmentsRows.error) throw enrollmentsRows.error;
    if (enrollmentsAllTimeRows.error) throw enrollmentsAllTimeRows.error;
    if (sessionsRows.error) throw sessionsRows.error;
    if (eventsRows.error) throw eventsRows.error;
    if (agentRunsRows.error) throw agentRunsRows.error;

    const sessions = ((sessionsRows.data ?? []) as Array<{
      id: string;
      location_id?: string | null;
      lead_name?: string | null;
      lead_phone?: string | null;
      lead_phone_norm?: string | null;
      created_at?: string | null;
      activated_at?: string | null;
      updated_at?: string | null;
    }>).filter((session) =>
      resolvedLocationId ? session.location_id === resolvedLocationId : true
    );
    const sessionIdSet = new Set(sessions.map((session) => session.id));
    const sessionById = new Map(sessions.map((session) => [session.id, session]));

    const enrollments = ((enrollmentsRows.data ?? []) as Array<{
      id: string;
      location_id?: string | null;
      lead_name?: string | null;
      lead_email?: string | null;
      lead_phone?: string | null;
      created_at?: string | null;
    }>).filter((row) =>
      resolvedLocationId ? row.location_id === resolvedLocationId : true
    );
    const enrollmentsAllTime = ((enrollmentsAllTimeRows.data ?? []) as Array<{
      location_id?: string | null;
      lead_name?: string | null;
      lead_email?: string | null;
      lead_phone?: string | null;
      created_at?: string | null;
    }>).filter((row) =>
      resolvedLocationId ? row.location_id === resolvedLocationId : true
    );

    const enrollmentIdSet = new Set(enrollments.map((item) => item.id));

    const events = ((eventsRows.data ?? []) as Array<{
      id: string;
      session_id?: string | null;
      event_type?: string | null;
      created_at?: string | null;
    }>).filter((event) => {
      const sessionId = String(event.session_id ?? "");
      if (!sessionId) return false;
      return sessionIdSet.has(sessionId);
    });
    const agentRuns = ((agentRunsRows.data ?? []) as Array<{
      id: string;
      location_id?: string | null;
      source?: string | null;
      conversation_id?: string | null;
      handoff_required?: boolean | null;
      handoff_reason?: string | null;
      follow_up_limit_reached?: boolean | null;
      safety_flags?: unknown;
      created_at?: string | null;
    }>).filter((row) => {
      if (row.source && row.source !== "suggest") return false;
      return resolvedLocationId ? row.location_id === resolvedLocationId : true;
    });

    const stepsRows = enrollmentIdSet.size
      ? await supabase
          .from("workflow_enrollment_steps")
          .select("id, enrollment_id, node_type, output, created_at")
          .in("enrollment_id", Array.from(enrollmentIdSet))
          .gte("created_at", previousStartIso)
          .order("created_at", { ascending: false })
          .limit(10000)
      : ({ data: [], error: null } as {
          data: Array<{ id: string; enrollment_id: string; node_type?: string | null; output?: unknown; created_at?: string | null }>;
          error: null;
        });
    if (stepsRows.error) throw stepsRows.error;
    const steps = (stepsRows.data ?? []) as Array<{
      id: string;
      enrollment_id: string;
      node_type?: string | null;
      output?: unknown;
      created_at?: string | null;
    }>;

    const eventSplit = splitCurrentPrevious(events, currentStartMs, previousStartMs);
    const stepSplit = splitCurrentPrevious(steps, currentStartMs, previousStartMs);
    const enrollmentSplit = splitCurrentPrevious(enrollments, currentStartMs, previousStartMs);
    const agentRunSplit = splitCurrentPrevious(agentRuns, currentStartMs, previousStartMs);

    const leadsTotal = leadSnapshot.total;
    const leadsCurrent = leadSnapshot.current;
    const leadsPrevious = leadSnapshot.previous;

    const messagesSentStepsCurrent = stepSplit.current.filter(isWorkflowStepMessageSent).length;
    const messagesSentStepsPrevious = stepSplit.previous.filter(isWorkflowStepMessageSent).length;

    const autoReplySentCurrent = eventSplit.current.filter(
      (event) => event.event_type === "auto_reply_sent"
    ).length;
    const autoReplySentPrevious = eventSplit.previous.filter(
      (event) => event.event_type === "auto_reply_sent"
    ).length;

    const aiChatsStartedCurrent = eventSplit.current.filter(
      (event) => event.event_type === "session_started"
    ).length;
    const aiChatsStartedPrevious = eventSplit.previous.filter(
      (event) => event.event_type === "session_started"
    ).length;

    const repliesCurrent = eventSplit.current.filter(
      (event) => event.event_type === "inbound_received"
    ).length;
    const repliesPrevious = eventSplit.previous.filter(
      (event) => event.event_type === "inbound_received"
    ).length;

    const messagesSentCurrent = messagesSentStepsCurrent + autoReplySentCurrent;
    const messagesSentPrevious = messagesSentStepsPrevious + autoReplySentPrevious;

    const isReviewNeededRun = (run: {
      handoff_required?: boolean | null;
      follow_up_limit_reached?: boolean | null;
      safety_flags?: unknown;
    }) => {
      if (run.handoff_required) return false;
      if (run.follow_up_limit_reached) return true;
      if (!Array.isArray(run.safety_flags)) return false;
      return run.safety_flags.length > 0;
    };

    const salesHandoverCurrent = agentRunSplit.current.filter((run) => Boolean(run.handoff_required)).length;
    const reviewNeededCurrent = agentRunSplit.current.filter(isReviewNeededRun).length;
    const activeRequests: Array<{
      id: string;
      type: "sales_handover" | "review_needed";
      leadName: string;
      leadPhone?: string | null;
      reason: string;
      createdAt: string;
    }> = [];
    const seenRequestKeys = new Set<string>();
    for (const run of agentRunSplit.current) {
      const type = run.handoff_required
        ? "sales_handover"
        : isReviewNeededRun(run)
        ? "review_needed"
        : null;
      if (!type) continue;
      const sessionId = toWorkflowSessionIdFromConversationId(run.conversation_id);
      const session = sessionId ? sessionById.get(sessionId) : undefined;
      const requestKey = `${type}:${sessionId ?? run.id}`;
      if (seenRequestKeys.has(requestKey)) continue;
      seenRequestKeys.add(requestKey);
      const safetyReason =
        Array.isArray(run.safety_flags) && run.safety_flags.length > 0
          ? String(run.safety_flags[0])
          : undefined;
      const reason =
        type === "sales_handover"
          ? String(run.handoff_reason ?? "").trim() || "AI agent vraagt menselijke opvolging."
          : run.follow_up_limit_reached
          ? "Follow-up limiet bereikt."
          : safetyReason
          ? `Safety check: ${safetyReason}`
          : "AI agent vraagt review.";
      activeRequests.push({
        id: run.id,
        type,
        leadName: String(session?.lead_name ?? "").trim() || "Onbekende lead",
        leadPhone: session?.lead_phone ?? null,
        reason,
        createdAt: String(run.created_at ?? new Date().toISOString()),
      });
      if (activeRequests.length >= 8) break;
    }

    const firstStartBySession = new Map<string, number>();
    const firstInboundBySession = new Map<string, number>();
    for (const event of events) {
      const sessionId = String(event.session_id ?? "");
      const ts = Date.parse(String(event.created_at ?? ""));
      if (!sessionId || !Number.isFinite(ts)) continue;
      if (event.event_type === "session_started") {
        const prev = firstStartBySession.get(sessionId);
        if (prev === undefined || ts < prev) firstStartBySession.set(sessionId, ts);
      }
      if (event.event_type === "inbound_received") {
        const prev = firstInboundBySession.get(sessionId);
        if (prev === undefined || ts < prev) firstInboundBySession.set(sessionId, ts);
      }
    }

    const responseDurationsMinutes: number[] = [];
    firstStartBySession.forEach((startMs, sessionId) => {
      if (startMs < currentStartMs) return;
      const inboundMs = firstInboundBySession.get(sessionId);
      if (inboundMs === undefined) return;
      if (inboundMs < startMs) return;
      responseDurationsMinutes.push((inboundMs - startMs) / 60_000);
    });
    const avgResponseMinutes =
      responseDurationsMinutes.length > 0
        ? responseDurationsMinutes.reduce((sum, value) => sum + value, 0) /
          responseDurationsMinutes.length
        : null;

    const toDeltaPct = (current: number, previous: number) => {
      if (previous <= 0) {
        if (current <= 0) return 0;
        return 100;
      }
      return ((current - previous) / previous) * 100;
    };

    const summary = {
      range,
      startAt: currentStartIso,
      endAt: new Date().toISOString(),
      locationId: resolvedLocationId ?? null,
      kpis: {
        leadsInTool: {
          current: leadsCurrent,
          previous: leadsPrevious,
          total: leadsTotal,
          deltaPct: toDeltaPct(leadsCurrent, leadsPrevious),
        },
        messagesSent: {
          current: messagesSentCurrent,
          previous: messagesSentPrevious,
          deltaPct: toDeltaPct(messagesSentCurrent, messagesSentPrevious),
        },
        aiChatsStarted: {
          current: aiChatsStartedCurrent,
          previous: aiChatsStartedPrevious,
          deltaPct: toDeltaPct(aiChatsStartedCurrent, aiChatsStartedPrevious),
        },
        repliesReceived: {
          current: repliesCurrent,
          previous: repliesPrevious,
          deltaPct: toDeltaPct(repliesCurrent, repliesPrevious),
        },
      },
      funnel: {
        leadsInTool: leadsTotal,
        aiStarted: aiChatsStartedCurrent,
        reactions: repliesCurrent,
        salesHandover: salesHandoverCurrent,
        reviewNeeded: reviewNeededCurrent,
      },
      performance: {
        conversionRate: aiChatsStartedCurrent > 0 ? repliesCurrent / aiChatsStartedCurrent : 0,
        avgResponseMinutes,
      },
      activeRequests,
      debug: {
        enrollmentsScanned: enrollments.length,
        sessionsScanned: sessions.length,
        eventsScanned: events.length,
        stepsScanned: steps.length,
        agentRunsScanned: agentRuns.length,
        opportunityScanned: leadSnapshot.scanned,
        opportunityPartial: leadSnapshot.partial,
        opportunityCachedAt: leadSnapshot.cachedAt,
      },
    };

    res.json(summary);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/drilldown", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    range: z.enum(["today", "7d", "30d"]).optional(),
    metric: z.enum(["leadsInTool", "messagesSent", "aiChatsStarted", "repliesReceived"]),
    limit: z.coerce.number().int().min(10).max(500).optional(),
  });
  try {
    const query = schema.parse(req.query);
    const range = query.range ?? "7d";
    const limit = query.limit ?? 200;
    const config = getGhlConfig(query.locationId);
    const resolvedLocationId = config.locationId;
    const currentStart = toPeriodStart(range);
    const currentStartIso = currentStart.toISOString();

    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }

    type DrilldownItem = {
      id: string;
      createdAt: string;
      title: string;
      subtitle?: string;
      detail?: string;
      source: string;
      channel?: string;
      payload?: Record<string, unknown> | null;
    };

    if (query.metric === "leadsInTool") {
      const stageMap = await getPipelineStageMap(config).catch(() => new Map<string, string>());
      const items: DrilldownItem[] = [];
      let total: number | undefined = undefined;
      let scanned = 0;
      let partial = false;
      let searchAfter: string | undefined = undefined;

      for (let page = 0; page < OPPORTUNITY_STATS_MAX_PAGES; page += 1) {
        const list = await listOpportunities(config, {
          limit: 100,
          searchAfter,
        });
        scanned += list.opportunities.length;
        if (typeof list.total === "number" && Number.isFinite(list.total)) {
          total = list.total;
        }

        for (const opportunity of list.opportunities) {
          const stage = displayStage(
            opportunity.pipelineStageName ??
              (opportunity.pipelineStageId
                ? stageMap.get(opportunity.pipelineStageId)
                : undefined)
          );
          const createdAt = String(
            opportunity.createdAt ?? opportunity.updatedAt ?? new Date().toISOString()
          );
          items.push({
            id: opportunity.id,
            createdAt,
            title: opportunity.name?.trim() || `Opportunity ${opportunity.id}`,
            subtitle: compactJoin([stage, opportunity.status], " · ") || undefined,
            detail:
              compactJoin(
                [
                  opportunity.contactId ? `Contact: ${opportunity.contactId}` : undefined,
                  opportunity.pipelineId ? `Pipeline: ${opportunity.pipelineId}` : undefined,
                  opportunity.pipelineStageId ? `Stage ID: ${opportunity.pipelineStageId}` : undefined,
                ],
                " · "
              ) || undefined,
            source: "ghl_opportunities",
            payload: {
              id: opportunity.id,
              name: opportunity.name ?? null,
              status: opportunity.status ?? null,
              contactId: opportunity.contactId ?? null,
              pipelineId: opportunity.pipelineId ?? null,
              pipelineStageId: opportunity.pipelineStageId ?? null,
              pipelineStageName: stage,
              createdAt: opportunity.createdAt ?? null,
              updatedAt: opportunity.updatedAt ?? null,
            },
          });
          if (items.length >= limit) break;
        }

        if (items.length >= limit) break;
        if (!list.searchAfter) {
          searchAfter = undefined;
          break;
        }
        searchAfter = list.searchAfter;
      }

      if (searchAfter) partial = true;

      res.json({
        metric: query.metric,
        range,
        locationId: resolvedLocationId ?? null,
        from: currentStartIso,
        to: new Date().toISOString(),
        count: total ?? scanned,
        partial,
        items,
      });
      return;
    }

    if (query.metric === "aiChatsStarted" || query.metric === "repliesReceived") {
      const eventType = query.metric === "aiChatsStarted" ? "session_started" : "inbound_received";
      const eventsRows = await supabase
        .from("workflow_agent_events")
        .select("id, session_id, event_type, level, message, payload, created_at")
        .eq("event_type", eventType)
        .gte("created_at", currentStartIso)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (eventsRows.error) throw eventsRows.error;

      const events = (eventsRows.data ?? []) as Array<{
        id: string;
        session_id?: string | null;
        event_type?: string | null;
        level?: "info" | "warn" | "error" | null;
        message?: string | null;
        payload?: unknown;
        created_at?: string | null;
      }>;
      const sessionIds = Array.from(new Set(events.map((event) => String(event.session_id ?? "")).filter(Boolean)));
      const sessionMap = new Map<
        string,
        {
          id: string;
          location_id?: string | null;
          lead_name?: string | null;
          lead_email?: string | null;
          lead_phone?: string | null;
          agent_id?: string | null;
          enrollment_id?: string | null;
        }
      >();
      if (sessionIds.length > 0) {
        for (const chunk of chunkArray(sessionIds, 200)) {
          const sessionsRows = await supabase
            .from("workflow_agent_sessions")
            .select("id, location_id, lead_name, lead_email, lead_phone, agent_id, enrollment_id")
            .in("id", chunk);
          if (sessionsRows.error) throw sessionsRows.error;
          for (const row of (sessionsRows.data ?? []) as Array<{
            id: string;
            location_id?: string | null;
            lead_name?: string | null;
            lead_email?: string | null;
            lead_phone?: string | null;
            agent_id?: string | null;
            enrollment_id?: string | null;
          }>) {
            sessionMap.set(row.id, row);
          }
        }
      }

      const items: DrilldownItem[] = events
        .map((event) => {
          const sessionId = String(event.session_id ?? "");
          const session = sessionId ? sessionMap.get(sessionId) : undefined;
          if (resolvedLocationId && session?.location_id !== resolvedLocationId) {
            return null;
          }
          const payload =
            event.payload && typeof event.payload === "object"
              ? (event.payload as Record<string, unknown>)
              : null;
          const detail =
            query.metric === "repliesReceived"
              ? compactJoin(
                  [
                    typeof payload?.bodyPreview === "string"
                      ? `Preview: ${String(payload.bodyPreview).slice(0, 160)}`
                      : undefined,
                    event.message ?? undefined,
                  ],
                  " · "
                )
              : compactJoin(
                  [
                    session?.agent_id ? `Agent: ${session.agent_id}` : undefined,
                    event.message ?? undefined,
                  ],
                  " · "
                );
          return {
            id: event.id,
            createdAt: String(event.created_at ?? new Date().toISOString()),
            title:
              query.metric === "aiChatsStarted"
                ? `AI sessie gestart - ${toLeadTitle(session)}`
                : `Reactie ontvangen - ${toLeadTitle(session)}`,
            subtitle: compactJoin([session?.lead_email, session?.lead_phone], " · ") || undefined,
            detail: detail || undefined,
            source: "workflow_agent_events",
            channel: "SMS",
            payload: {
              sessionId: sessionId || null,
              eventType: event.event_type ?? null,
              level: event.level ?? null,
              message: event.message ?? null,
              leadName: session?.lead_name ?? null,
              leadEmail: session?.lead_email ?? null,
              leadPhone: session?.lead_phone ?? null,
              rawPayload: payload,
            },
          } as DrilldownItem;
        })
        .filter((item): item is DrilldownItem => Boolean(item))
        .slice(0, limit);

      res.json({
        metric: query.metric,
        range,
        locationId: resolvedLocationId ?? null,
        from: currentStartIso,
        to: new Date().toISOString(),
        count: items.length,
        items,
      });
      return;
    }

    const stepsRows = await supabase
      .from("workflow_enrollment_steps")
      .select("id, enrollment_id, node_type, output, created_at")
      .gte("created_at", currentStartIso)
      .order("created_at", { ascending: false })
      .limit(6000);
    if (stepsRows.error) throw stepsRows.error;
    const rawSteps = (stepsRows.data ?? []) as Array<{
      id: string;
      enrollment_id: string;
      node_type?: string | null;
      output?: unknown;
      created_at?: string | null;
    }>;
    const sentSteps = rawSteps.filter(isWorkflowStepMessageSent);
    const enrollmentIds = Array.from(
      new Set(sentSteps.map((step) => String(step.enrollment_id ?? "")).filter(Boolean))
    );
    const enrollmentMap = new Map<
      string,
      {
        id: string;
        location_id?: string | null;
        lead_name?: string | null;
        lead_email?: string | null;
        lead_phone?: string | null;
      }
    >();
    if (enrollmentIds.length > 0) {
      for (const chunk of chunkArray(enrollmentIds, 200)) {
        const enrollmentsRows = await supabase
          .from("workflow_enrollments")
          .select("id, location_id, lead_name, lead_email, lead_phone")
          .in("id", chunk);
        if (enrollmentsRows.error) throw enrollmentsRows.error;
        for (const row of (enrollmentsRows.data ?? []) as Array<{
          id: string;
          location_id?: string | null;
          lead_name?: string | null;
          lead_email?: string | null;
          lead_phone?: string | null;
        }>) {
          enrollmentMap.set(row.id, row);
        }
      }
    }

    const stepItems: DrilldownItem[] = sentSteps
      .map((step) => {
        const enrollment = enrollmentMap.get(step.enrollment_id);
        if (resolvedLocationId && enrollment?.location_id !== resolvedLocationId) return null;
        const output = parseStepOutput(step.output);
        const nodeType = String(step.node_type ?? "");
        const channel =
          nodeType === "action.email" ? "EMAIL" : nodeType === "action.sms" ? "SMS" : "SMS";
        const titlePrefix =
          nodeType === "action.email"
            ? "E-mail verstuurd"
            : nodeType === "action.sms"
            ? "SMS verstuurd"
            : "Agent bericht verstuurd";
        const delivery =
          output.delivery && typeof output.delivery === "object"
            ? (output.delivery as Record<string, unknown>)
            : null;
        return {
          id: step.id,
          createdAt: String(step.created_at ?? new Date().toISOString()),
          title: `${titlePrefix} - ${toLeadTitle(enrollment)}`,
          subtitle: compactJoin([enrollment?.lead_email, enrollment?.lead_phone], " · ") || undefined,
          detail: compactJoin(
            [
              nodeType || undefined,
              typeof delivery?.providerMessageId === "string"
                ? `MsgId: ${delivery.providerMessageId}`
                : undefined,
              typeof output.reason === "string" ? output.reason : undefined,
            ],
            " · "
          ),
          source: "workflow_enrollment_steps",
          channel,
          payload: {
            nodeType,
            enrollmentId: step.enrollment_id,
            leadName: enrollment?.lead_name ?? null,
            leadEmail: enrollment?.lead_email ?? null,
            leadPhone: enrollment?.lead_phone ?? null,
            output,
          },
        } as DrilldownItem;
      })
      .filter((item): item is DrilldownItem => Boolean(item));

    const autoReplyRows = await supabase
      .from("workflow_agent_events")
      .select("id, session_id, event_type, level, message, payload, created_at")
      .eq("event_type", "auto_reply_sent")
      .gte("created_at", currentStartIso)
      .order("created_at", { ascending: false })
      .limit(4000);
    if (autoReplyRows.error) throw autoReplyRows.error;
    const autoReplyEvents = (autoReplyRows.data ?? []) as Array<{
      id: string;
      session_id?: string | null;
      event_type?: string | null;
      level?: "info" | "warn" | "error" | null;
      message?: string | null;
      payload?: unknown;
      created_at?: string | null;
    }>;
    const autoReplySessionIds = Array.from(
      new Set(autoReplyEvents.map((event) => String(event.session_id ?? "")).filter(Boolean))
    );
    const autoReplySessionMap = new Map<
      string,
      {
        id: string;
        location_id?: string | null;
        lead_name?: string | null;
        lead_email?: string | null;
        lead_phone?: string | null;
      }
    >();
    if (autoReplySessionIds.length > 0) {
      for (const chunk of chunkArray(autoReplySessionIds, 200)) {
        const sessionsRows = await supabase
          .from("workflow_agent_sessions")
          .select("id, location_id, lead_name, lead_email, lead_phone")
          .in("id", chunk);
        if (sessionsRows.error) throw sessionsRows.error;
        for (const row of (sessionsRows.data ?? []) as Array<{
          id: string;
          location_id?: string | null;
          lead_name?: string | null;
          lead_email?: string | null;
          lead_phone?: string | null;
        }>) {
          autoReplySessionMap.set(row.id, row);
        }
      }
    }

    const autoReplyItems: DrilldownItem[] = autoReplyEvents
      .map((event) => {
        const sessionId = String(event.session_id ?? "");
        const session = sessionId ? autoReplySessionMap.get(sessionId) : undefined;
        if (resolvedLocationId && session?.location_id !== resolvedLocationId) return null;
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : null;
        return {
          id: event.id,
          createdAt: String(event.created_at ?? new Date().toISOString()),
          title: `AI auto-reply verzonden - ${toLeadTitle(session)}`,
          subtitle: compactJoin([session?.lead_email, session?.lead_phone], " · ") || undefined,
          detail: compactJoin(
            [
              typeof payload?.providerMessageId === "string"
                ? `MsgId: ${String(payload.providerMessageId)}`
                : undefined,
              event.message ?? undefined,
            ],
            " · "
          ),
          source: "workflow_agent_events",
          channel: "SMS",
          payload: {
            sessionId: sessionId || null,
            leadName: session?.lead_name ?? null,
            leadEmail: session?.lead_email ?? null,
            leadPhone: session?.lead_phone ?? null,
            rawPayload: payload,
          },
        } as DrilldownItem;
      })
      .filter((item): item is DrilldownItem => Boolean(item));

    const items = [...stepItems, ...autoReplyItems]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);

    res.json({
      metric: query.metric,
      range,
      locationId: resolvedLocationId ?? null,
      from: currentStartIso,
      to: new Date().toISOString(),
      count: items.length,
      items,
    });
  } catch (error) {
    next(error);
  }
});

const workflowNodeTypeSchema = z.enum([
  "trigger.manual",
  "trigger.voicemail5",
  "action.email",
  "action.sms",
  "action.wait",
  "action.agent",
]);

const workflowSettingsSchema = z
  .object({
    sendWindow: z
      .object({
        enabled: z.boolean().default(false),
        startTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .default("09:00"),
        endTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .default("17:00"),
        days: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
        timezone: z.string().optional(),
      })
      .optional(),
  })
  .default({});

const workflowDefinitionSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      type: workflowNodeTypeSchema,
      position: z.object({ x: z.number(), y: z.number() }),
      data: z.record(z.unknown()).default({}),
    })
  ),
  edges: z.array(
    z.object({
      id: z.string().min(1),
      source: z.string().min(1),
      target: z.string().min(1),
    })
  ),
  settings: workflowSettingsSchema.optional(),
});

type EnrollmentStepLike = {
  nodeId: string;
  nodeType: string;
  status: "success" | "failed";
  output?: Record<string, unknown>;
};

const resolveEnrollmentCurrentNodeId = (
  steps: EnrollmentStepLike[]
): string | undefined => {
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  const failed = steps.find((step) => step.status === "failed");
  if (failed?.nodeId) return failed.nodeId;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (!step) continue;
    if (step.output && typeof step.output === "object" && step.output["paused"] === true) {
      return step.nodeId;
    }
  }
  return steps[steps.length - 1]?.nodeId;
};

const inferLeadChannelFromEnrollmentSteps = (
  steps: EnrollmentStepLike[]
): "SMS" | "EMAIL" | undefined => {
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (!step || step.status !== "success") continue;
    if (step.nodeType === "action.email") return "EMAIL";
    if (step.nodeType === "action.sms") return "SMS";
  }
  return undefined;
};

const createWorkflowAgentHandoff = (context?: {
  resolvedLocationId?: string;
  workflowId?: string;
  enrollmentId?: string;
}) =>
  async ({
    agentId,
    notes,
    lead,
  }: {
    agentId: string;
    notes?: string;
    lead?: {
      name?: string;
      email?: string;
      phone?: string;
      contactId?: string;
      conversationId?: string;
      channel?: "SMS" | "EMAIL";
      lastMessage?: string;
    };
  }) => {
    const resolvedLocationId = context?.resolvedLocationId;
    const agent = await getAgent(agentId);
    if (!agent) {
      throw new Error("Agent niet gevonden.");
    }
    if (resolvedLocationId && agent.locationId !== resolvedLocationId) {
      throw new Error("Geselecteerde agent hoort niet bij deze subaccount.");
    }
    const settings = await getResolvedAgentSettings(agentId);
    if (!settings) {
      throw new Error("Agent settings niet gevonden.");
    }

    const nowIso = new Date().toISOString();
    const channel = lead?.channel === "EMAIL" ? "EMAIL" : "SMS";
    const type = channel === "EMAIL" ? "TYPE_EMAIL" : "TYPE_SMS";
    const inbound = (lead?.lastMessage ?? notes ?? "").trim();
    const leadNameParts = splitNameParts(lead?.name);
    const syntheticContactId = `wf-test-contact-${agentId}`;
    const syntheticConversationId = `wf-test-convo-${agentId}`;
    const contact = {
      id: syntheticContactId,
      firstName: leadNameParts.firstName ?? "Workflow",
      lastName: leadNameParts.lastName ?? "test lead",
      email: lead?.email ?? undefined,
      phone: lead?.phone ?? undefined,
      source: "workflow-test",
      dateAdded: nowIso,
    };

    let suggestionText: string | undefined;
    if (inbound) {
      const suggestion = await suggestReply({
        contact,
        conversation: {
          id: syntheticConversationId,
          channel,
          source: "workflow-test",
          dateAdded: nowIso,
          dateUpdated: nowIso,
        },
        messages: [
          {
            id: `${syntheticConversationId}-inbound-1`,
            conversationId: syntheticConversationId,
            contactId: syntheticContactId,
            type,
            direction: "inbound",
            body: inbound,
            timestamp: nowIso,
          },
        ],
        maxMessages: 1,
        agent: settings as any,
      });
      suggestionText = suggestion.text?.trim() || undefined;
    } else if (typeof settings.firstMessage === "string" && settings.firstMessage.trim()) {
      suggestionText = renderContactTemplate(settings.firstMessage, contact as any).trim();
    }

    let delivery: Record<string, unknown> | undefined;
    if (suggestionText) {
      if (!resolvedLocationId) {
        throw new Error(
          "Workflow Agent handoff via GHL vereist een geldige subaccount/locationId."
        );
      }
      const result = await sendWorkflowMessageViaGhl({
        resolvedLocationId,
        channel,
        body: suggestionText,
        subject: channel === "EMAIL" ? "Opvolging" : undefined,
        lead: {
          name: lead?.name,
          email: lead?.email,
          phone: lead?.phone,
          contactId: lead?.contactId,
          conversationId: lead?.conversationId,
        },
      });
      delivery = result;
      if (context?.workflowId) {
        const leadContactId = result.contactId;
        const leadConversationId = result.conversationId;
        const normalizedChannel = channel === "EMAIL" ? "EMAIL" : "SMS";
        const session = await upsertWorkflowAgentSession({
          workflowId: context.workflowId,
          enrollmentId: context.enrollmentId,
          locationId: resolvedLocationId ?? agent.locationId,
          agentId: agent.id,
          channel: normalizedChannel,
          leadName: lead?.name,
          leadEmail: lead?.email,
          leadPhone: lead?.phone,
          ghlContactId: leadContactId,
          ghlConversationId: leadConversationId,
          lastOutboundAt: new Date().toISOString(),
          lastOutboundMessageId: result.providerMessageId ?? undefined,
        });
        const followUpPlan = await resetWorkflowAgentFollowUpSchedule({
          sessionId: session.id,
          agentSettings: (settings as Record<string, unknown>) ?? undefined,
          outboundAt: session.lastOutboundAt ?? nowIso,
        }).catch(() => ({
          plan: {
            enabled: false,
            maxFollowUps: 0,
            scheduleHours: [] as number[],
            minDelayMinutes: 0,
            maxDelayMinutes: 0,
          },
          nextFollowUpAt: null as string | null,
        }));
        await recordWorkflowAgentEvent({
          workflowId: context.workflowId,
          sessionId: session.id,
          enrollmentId: context.enrollmentId,
          eventType: "session_started",
          level: "info",
          message: "Agent module heeft sessie gestart en eerste bericht via GHL verstuurd.",
          payload: {
            agentId: agent.id,
            channel: normalizedChannel,
            leadPhone: lead?.phone ?? null,
            leadEmail: lead?.email ?? null,
            contactId: leadContactId ?? null,
            conversationId: leadConversationId ?? null,
            providerMessageId: result.providerMessageId ?? null,
            followUpScheduleHours: followUpPlan.plan.scheduleHours,
            followUpAutoEnabled: followUpPlan.plan.enabled,
            followUpDelayMinMinutes: followUpPlan.plan.minDelayMinutes,
            followUpDelayMaxMinutes: followUpPlan.plan.maxDelayMinutes,
            nextFollowUpAt: followUpPlan.nextFollowUpAt,
          },
        }).catch(() => undefined);
      }
    } else {
      delivery = {
        channel,
        status: "skipped",
        reason: "Geen agent bericht gegenereerd om te verzenden.",
      };
    }

    return {
      handoff: "queued",
      agentId: agent.id,
      agentName: agent.name,
      agentVersion: agent.currentVersion,
      locationId: resolvedLocationId ?? agent.locationId,
      notes: notes ?? undefined,
      suggestedReply: suggestionText,
      delivery,
    };
  };

const workflowWaitTimers = new Map<string, NodeJS.Timeout>();

const clearWorkflowWaitTimer = (enrollmentId: string) => {
  const existing = workflowWaitTimers.get(enrollmentId);
  if (!existing) return;
  clearTimeout(existing);
  workflowWaitTimers.delete(enrollmentId);
};

const parseWaitDurationMs = (output?: Record<string, unknown>) => {
  if (!output || typeof output !== "object") return null;
  const rawAmount = Number(output["amount"]);
  const unit = String(output["unit"] ?? "").toLowerCase();
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) return null;
  const amount = Math.floor(rawAmount);
  if (unit === "minutes") return amount * 60_000;
  if (unit === "hours") return amount * 60 * 60_000;
  if (unit === "days") return amount * 24 * 60 * 60_000;
  return null;
};

const getPausedWaitStep = (
  steps: Array<{ nodeId: string; type: string; output?: Record<string, unknown> }>
) => {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (!step) continue;
    if (step.type !== "action.wait") continue;
    if (step.output?.paused === true) return step;
  }
  return null;
};

const advanceWorkflowEnrollment = async (input: {
  workflowId: string;
  enrollmentId: string;
  resolvedLocationId?: string;
  ignoreSendWindow?: boolean;
}) => {
  clearWorkflowWaitTimer(input.enrollmentId);

  const workflow = await getWorkflow(input.workflowId);
  if (!workflow) {
    throw new Error("Workflow niet gevonden.");
  }
  const enrollment = await getWorkflowEnrollment(workflow.id, input.enrollmentId);
  if (!enrollment) {
    throw new Error("Enrollment niet gevonden.");
  }

  const validation = buildLinearChain(workflow.definition);
  if ("message" in validation) {
    throw new Error(validation.message);
  }
  const chain = validation.chain;
  const currentNodeId = resolveEnrollmentCurrentNodeId(enrollment.steps as EnrollmentStepLike[]);
  const currentIndex = currentNodeId
    ? chain.findIndex((node) => node.id === currentNodeId)
    : -1;
  const nextNode = chain[currentIndex + 1];
  if (!nextNode) {
    return {
      report: null,
      enrollment,
      message: "Enrollment zit al op de laatste stap.",
    };
  }

  const handoffToAgent = createWorkflowAgentHandoff({
    resolvedLocationId: input.resolvedLocationId ?? enrollment.locationId ?? undefined,
    workflowId: workflow.id,
    enrollmentId: enrollment.id,
  });
  const shouldIgnoreSendWindow =
    typeof input.ignoreSendWindow === "boolean"
      ? input.ignoreSendWindow
      : enrollment.source === "manual_test";
  const inferredLeadChannel =
    inferLeadChannelFromEnrollmentSteps(enrollment.steps as EnrollmentStepLike[]) ??
    (enrollment.leadEmail && !enrollment.leadPhone
      ? "EMAIL"
      : enrollment.leadPhone && !enrollment.leadEmail
        ? "SMS"
        : undefined);
  const report = await runWorkflowTest({
    definition: workflow.definition,
    startNodeId: nextNode.id,
    pauseAtWait: true,
    ignoreSendWindow: shouldIgnoreSendWindow,
    testRecipients: {
      leadName: enrollment.leadName ?? undefined,
      leadEmail: enrollment.leadEmail ?? undefined,
      leadPhone: enrollment.leadPhone ?? undefined,
      leadChannel: inferredLeadChannel,
    },
    sendEmail: async ({ to, subject, body }) => {
      const result = await sendWorkflowMessageViaGhl({
        resolvedLocationId:
          input.resolvedLocationId ?? enrollment.locationId ?? undefined,
        channel: "EMAIL",
        body,
        subject,
        lead: {
          name: enrollment.leadName ?? undefined,
          email: to || enrollment.leadEmail || undefined,
          phone: enrollment.leadPhone ?? undefined,
        },
      });
      return {
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        contactId: result.contactId,
        conversationId: result.conversationId,
      };
    },
    sendSms: async ({ to, message }) => {
      const result = await sendWorkflowMessageViaGhl({
        resolvedLocationId:
          input.resolvedLocationId ?? enrollment.locationId ?? undefined,
        channel: "SMS",
        body: message,
        lead: {
          name: enrollment.leadName ?? undefined,
          phone: to || enrollment.leadPhone || undefined,
          email: enrollment.leadEmail ?? undefined,
        },
      });
      return {
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        contactId: result.contactId,
        conversationId: result.conversationId,
      };
    },
    handoffToAgent,
  });

  await appendWorkflowEnrollmentSteps(
    enrollment.id,
    (report.steps ?? []).map((step) => ({
      nodeId: String(step.nodeId),
      nodeType: String(step.type),
      status: step.status,
      output: step.output,
    }))
  );
  await updateWorkflowEnrollmentStatus(
    workflow.id,
    enrollment.id,
    report.status,
    new Date().toISOString()
  );
  const updated = (await getWorkflowEnrollment(workflow.id, enrollment.id)) ?? enrollment;

  const pausedStep = getPausedWaitStep(
    (report.steps ?? []).map((step) => ({
      nodeId: String(step.nodeId),
      type: String(step.type),
      output: step.output,
    }))
  );
  if (pausedStep) {
    const waitMs = parseWaitDurationMs(pausedStep.output);
    if (waitMs && waitMs > 0) {
      const maxWaitMs = 7 * 24 * 60 * 60_000;
      const delayMs = Math.min(waitMs, maxWaitMs);
      const timer = setTimeout(async () => {
        workflowWaitTimers.delete(updated.id);
        try {
            await advanceWorkflowEnrollment({
              workflowId: workflow.id,
              enrollmentId: updated.id,
              resolvedLocationId: input.resolvedLocationId ?? updated.locationId ?? undefined,
              ignoreSendWindow: undefined,
            });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Onbekende fout";
          console.error("Workflow auto-advance fout:", message);
        }
      }, delayMs);
      workflowWaitTimers.set(updated.id, timer);
    }
  }

  return {
    report,
    enrollment: updated,
    message: undefined as string | undefined,
  };
};

app.post("/api/workflows", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(["draft", "active", "inactive"]).default("draft"),
    definition: workflowDefinitionSchema,
  });

  try {
    const body = schema.parse(req.body);
    const validation = buildLinearChain(body.definition);
    if ("message" in validation) {
      res.status(400).json({ error: validation.message, nodeId: validation.nodeId });
      return;
    }
    const workflow = await createWorkflow({
      name: body.name,
      description: body.description ?? null,
      status: body.status,
      definition: body.definition,
    });
    res.json({ workflow });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflows/:id", async (req, res, next) => {
  try {
    const workflow = await getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow niet gevonden." });
      return;
    }
    res.json({ workflow });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflows/:id/enrollments", async (req, res, next) => {
  const schema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });
  try {
    const query = schema.parse(req.query);
    const workflow = await getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow niet gevonden." });
      return;
    }
    const enrollments = await listWorkflowEnrollments(req.params.id, query.limit ?? 50);
    res.json({ enrollments });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflows/:id/debug", async (req, res, next) => {
  const schema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });
  try {
    const query = schema.parse(req.query);
    const workflow = await getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow niet gevonden." });
      return;
    }

    const sessions = await listWorkflowAgentSessions(workflow.id, query.limit ?? 30);
    const agentEvents = await listWorkflowAgentEvents({
      workflowId: workflow.id,
      limit: 600,
    });
    if (sessions.length === 0) {
      res.json({
        summary: {
          total: 0,
          active: 0,
          inactive: 0,
          autoReplyReady: 0,
          totalEvents: agentEvents.length,
          errorEvents: agentEvents.filter((event) => event.level === "error").length,
        },
        sessions: [],
      });
      return;
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }

    const agentIds = Array.from(new Set(sessions.map((item) => item.agentId).filter(Boolean)));
    const enrollmentIds = Array.from(
      new Set(sessions.map((item) => item.enrollmentId).filter((item): item is string => typeof item === "string"))
    );
    const conversationIds = sessions.map((item) => `workflow-agent-session-${item.id}`);

    const [agentRows, enrollmentRows, stepRows, runRows] = await Promise.all([
      agentIds.length > 0
        ? supabase
            .from("ai_agents")
            .select("id, name, active, status")
            .in("id", agentIds)
        : Promise.resolve({ data: [], error: null } as any),
      enrollmentIds.length > 0
        ? supabase
            .from("workflow_enrollments")
            .select("id, status, source, created_at, completed_at")
            .in("id", enrollmentIds)
        : Promise.resolve({ data: [], error: null } as any),
      enrollmentIds.length > 0
        ? supabase
            .from("workflow_enrollment_steps")
            .select("enrollment_id, node_id, node_type, status, output, created_at")
            .in("enrollment_id", enrollmentIds)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null } as any),
      conversationIds.length > 0
        ? supabase
            .from("ai_agent_runs")
            .select(
              "id, conversation_id, source, model, response_ms, handoff_required, handoff_reason, safety_flags, created_at"
            )
            .in("conversation_id", conversationIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null } as any),
    ]);

    if (agentRows.error) throw agentRows.error;
    if (enrollmentRows.error) throw enrollmentRows.error;
    if (stepRows.error) throw stepRows.error;
    if (runRows.error) throw runRows.error;

    const agentById = new Map<string, { id: string; name: string; active: boolean; status: string }>();
    (agentRows.data ?? []).forEach((row: any) => {
      agentById.set(String(row.id), {
        id: String(row.id),
        name: String(row.name ?? "Agent"),
        active: Boolean(row.active),
        status: String(row.status ?? "draft"),
      });
    });

    const enrollmentById = new Map<
      string,
      { id: string; status: string; source: string; createdAt?: string; completedAt?: string }
    >();
    (enrollmentRows.data ?? []).forEach((row: any) => {
      enrollmentById.set(String(row.id), {
        id: String(row.id),
        status: String(row.status ?? "unknown"),
        source: String(row.source ?? "unknown"),
        createdAt: row.created_at ? String(row.created_at) : undefined,
        completedAt: row.completed_at ? String(row.completed_at) : undefined,
      });
    });

    const stepsByEnrollment = new Map<
      string,
      Array<{
        nodeId: string;
        nodeType: string;
        status: "success" | "failed";
        output?: Record<string, unknown>;
        createdAt: string;
      }>
    >();
    (stepRows.data ?? []).forEach((row: any) => {
      const key = String(row.enrollment_id);
      const list = stepsByEnrollment.get(key) ?? [];
      list.push({
        nodeId: String(row.node_id),
        nodeType: String(row.node_type),
        status: (String(row.status) === "failed" ? "failed" : "success") as "success" | "failed",
        output:
          row.output && typeof row.output === "object"
            ? (row.output as Record<string, unknown>)
            : undefined,
        createdAt: String(row.created_at),
      });
      stepsByEnrollment.set(key, list);
    });

    const runByConversation = new Map<
      string,
      {
        id: string;
        source: string;
        model?: string;
        responseMs?: number;
        handoffRequired: boolean;
        handoffReason?: string;
        safetyFlags: string[];
        createdAt: string;
      }
    >();
    (runRows.data ?? []).forEach((row: any) => {
      const key = String(row.conversation_id ?? "");
      if (!key || runByConversation.has(key)) return;
      runByConversation.set(key, {
        id: String(row.id),
        source: String(row.source ?? "suggest"),
        model: row.model ? String(row.model) : undefined,
        responseMs: typeof row.response_ms === "number" ? row.response_ms : undefined,
        handoffRequired: Boolean(row.handoff_required),
        handoffReason: row.handoff_reason ? String(row.handoff_reason) : undefined,
        safetyFlags: Array.isArray(row.safety_flags)
          ? row.safety_flags.map((item: unknown) => String(item))
          : [],
        createdAt: String(row.created_at),
      });
    });

    const eventsBySession = new Map<
      string,
      Array<{
        id: string;
        eventType: string;
        level: "info" | "warn" | "error";
        message: string;
        payload?: Record<string, unknown>;
        createdAt: string;
      }>
    >();
    agentEvents.forEach((event) => {
      if (!event.sessionId) return;
      const existing = eventsBySession.get(event.sessionId) ?? [];
      existing.push({
        id: event.id,
        eventType: event.eventType,
        level: event.level,
        message: event.message,
        payload: event.payload,
        createdAt: event.createdAt,
      });
      eventsBySession.set(event.sessionId, existing);
    });

    const sessionDetails = await Promise.all(
      sessions.map(async (session) => {
        const [inboundRows, outboundRows] = await Promise.all([
          supabase
            .from("sms_inbound")
            .select("id, from_phone, to_phone, body, created_at, timestamp")
            .or(`from_phone.ilike.%${session.leadPhoneNorm}%`)
            .order("created_at", { ascending: false })
            .limit(25),
          supabase
            .from("sms_events")
            .select("id, from_phone, to_phone, body, status, created_at")
            .or(`to_phone.ilike.%${session.leadPhoneNorm}%`)
            .order("created_at", { ascending: false })
            .limit(25),
        ]);
        if (inboundRows.error) throw inboundRows.error;
        if (outboundRows.error) throw outboundRows.error;

        const lastInbound = (inboundRows.data ?? []).find((item: any) => {
          const leadMatches = phonesLikelyMatch(item.from_phone, session.leadPhone);
          if (!leadMatches) return false;
          if (!session.twilioToPhone) return true;
          return phonesLikelyMatch(item.to_phone, session.twilioToPhone);
        });
        const lastOutbound = (outboundRows.data ?? []).find((item: any) => {
          const leadMatches = phonesLikelyMatch(item.to_phone, session.leadPhone);
          if (!leadMatches) return false;
          if (!session.twilioToPhone) return true;
          return phonesLikelyMatch(item.from_phone, session.twilioToPhone);
        });

        const enrollment = session.enrollmentId
          ? enrollmentById.get(session.enrollmentId)
          : undefined;
        const steps = session.enrollmentId
          ? stepsByEnrollment.get(session.enrollmentId) ?? []
          : [];
        const currentStep = (() => {
          if (!steps.length) return undefined;
          const failed = steps.find((step) => step.status === "failed");
          if (failed) return failed;
          for (let i = steps.length - 1; i >= 0; i -= 1) {
            const step = steps[i];
            if (!step) continue;
            if (step.output?.paused === true) return step;
          }
          return steps[steps.length - 1];
        })();

        const agent = agentById.get(session.agentId);
        const lastRun = runByConversation.get(`workflow-agent-session-${session.id}`);

        const autoReplyReady = Boolean(session.active && agent?.active && session.leadPhoneNorm);
        const statusReason = !session.active
          ? "Sessie is inactief."
          : !agent
          ? "Agent niet gevonden."
          : !agent.active
          ? "Agent is niet actief."
          : "Klaar voor auto-reply.";

        return {
          id: session.id,
          workflowId: session.workflowId,
          enrollmentId: session.enrollmentId,
          locationId: session.locationId,
          active: session.active,
          activatedAt: session.activatedAt,
          updatedAt: session.updatedAt,
          lead: {
            name: session.leadName,
            email: session.leadEmail,
            phone: session.leadPhone,
            phoneNorm: session.leadPhoneNorm,
          },
          twilio: {
            fromPhone: session.twilioToPhone ?? null,
          },
          agent: {
            id: session.agentId,
            name: agent?.name ?? "Onbekende agent",
            active: agent?.active ?? false,
            status: agent?.status ?? "unknown",
          },
          enrollment: enrollment
            ? {
                id: enrollment.id,
                status: enrollment.status,
                source: enrollment.source,
                currentNodeId: currentStep?.nodeId,
                currentNodeType: currentStep?.nodeType,
                currentNodeStatus: currentStep?.status,
                currentNodePaused: Boolean(currentStep?.output?.paused),
                createdAt: enrollment.createdAt,
                completedAt: enrollment.completedAt,
              }
            : null,
          autoReply: {
            ready: autoReplyReady,
            reason: statusReason,
            lastInboundAt: session.lastInboundAt ?? null,
            lastOutboundAt: session.lastOutboundAt ?? null,
          },
          lastInboundMessage: lastInbound
            ? {
                body: String(lastInbound.body ?? ""),
                fromPhone: String(lastInbound.from_phone ?? ""),
                toPhone: String(lastInbound.to_phone ?? ""),
                timestamp: String(lastInbound.timestamp ?? lastInbound.created_at ?? ""),
              }
            : null,
          lastOutboundMessage: lastOutbound
            ? {
                body: String(lastOutbound.body ?? ""),
                fromPhone: String(lastOutbound.from_phone ?? ""),
                toPhone: String(lastOutbound.to_phone ?? ""),
                status: String(lastOutbound.status ?? ""),
                timestamp: String(lastOutbound.created_at ?? ""),
              }
            : null,
          lastAgentRun: lastRun ?? null,
          recentEvents: (eventsBySession.get(session.id) ?? []).slice(0, 8),
        };
      })
    );

    const summary = {
      total: sessionDetails.length,
      active: sessionDetails.filter((item) => item.active).length,
      inactive: sessionDetails.filter((item) => !item.active).length,
      autoReplyReady: sessionDetails.filter((item) => item.autoReply.ready).length,
      totalEvents: agentEvents.length,
      errorEvents: agentEvents.filter((event) => event.level === "error").length,
    };

    res.json({
      summary,
      sessions: sessionDetails,
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/workflows/:id", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(["draft", "active", "inactive"]).default("draft"),
    definition: workflowDefinitionSchema,
  });

  try {
    const body = schema.parse(req.body);
    const validation = buildLinearChain(body.definition);
    if ("message" in validation) {
      res.status(400).json({ error: validation.message, nodeId: validation.nodeId });
      return;
    }

    const workflow = await updateWorkflow(req.params.id, {
      name: body.name,
      description: body.description ?? null,
      status: body.status,
      definition: body.definition,
    });
    if (!workflow) {
      res.status(404).json({ error: "Workflow niet gevonden." });
      return;
    }
    res.json({ workflow });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workflows/:id", async (req, res, next) => {
  try {
    const deleted = await deleteWorkflow(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Workflow niet gevonden." });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows/:id/test", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    testRecipients: z
      .object({
        emailToOverride: z.string().optional(),
        smsToOverride: z.string().optional(),
        leadName: z.string().optional(),
        leadEmail: z.string().optional(),
        leadPhone: z.string().optional(),
        leadContactId: z.string().optional(),
        leadConversationId: z.string().optional(),
        leadChannel: z.enum(["SMS", "EMAIL"]).optional(),
        leadLastMessage: z.string().optional(),
      })
      .optional(),
  });

  try {
    const body = schema.parse(req.body ?? {});
    const resolvedLocationId = body.locationId
      ? getGhlConfig(body.locationId).locationId
      : undefined;
    const workflow = await getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow niet gevonden." });
      return;
    }

    const validation = buildLinearChain(workflow.definition);
    if ("message" in validation) {
      res.status(400).json({ error: validation.message, nodeId: validation.nodeId });
      return;
    }

    const startedAt = new Date().toISOString();
    const handoffToAgent = createWorkflowAgentHandoff({
      resolvedLocationId,
      workflowId: workflow.id,
    });
    const report = await runWorkflowTest({
      definition: workflow.definition,
      testRecipients: body.testRecipients,
      pauseAtWait: true,
      sendEmail: async ({ to, subject, body: emailBody }) => {
        const result = await sendWorkflowMessageViaGhl({
          resolvedLocationId,
          channel: "EMAIL",
          body: emailBody,
          subject,
          lead: {
            name: body.testRecipients?.leadName,
            email: to || body.testRecipients?.leadEmail,
            phone: body.testRecipients?.leadPhone,
            contactId: body.testRecipients?.leadContactId,
            conversationId: body.testRecipients?.leadConversationId,
          },
        });
        return {
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          contactId: result.contactId,
          conversationId: result.conversationId,
        };
      },
      sendSms: async ({ to, message }) => {
        const result = await sendWorkflowMessageViaGhl({
          resolvedLocationId,
          channel: "SMS",
          body: message,
          lead: {
            name: body.testRecipients?.leadName,
            email: body.testRecipients?.leadEmail,
            phone: to || body.testRecipients?.leadPhone,
            contactId: body.testRecipients?.leadContactId,
            conversationId: body.testRecipients?.leadConversationId,
          },
        });
        return {
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          contactId: result.contactId,
          conversationId: result.conversationId,
        };
      },
      handoffToAgent,
    });

    let enrollmentId: string | undefined;
    try {
      enrollmentId = await recordWorkflowEnrollmentExecution({
        workflowId: workflow.id,
        locationId: resolvedLocationId,
        source: "manual_test",
        lead: {
          name: body.testRecipients?.leadName,
          email: body.testRecipients?.leadEmail,
          phone: body.testRecipients?.leadPhone,
        },
        status: report.status,
        startedAt,
        completedAt: new Date().toISOString(),
        steps: (report.steps ?? []).map((step) => ({
          nodeId: String(step.nodeId),
          nodeType: String(step.type),
          status: step.status,
          output: step.output,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Onbekende fout";
      console.error("Workflow enrollment logging fout:", message);
    }

    const pausedStep = getPausedWaitStep(
      (report.steps ?? []).map((step) => ({
        nodeId: String(step.nodeId),
        type: String(step.type),
        output: step.output,
      }))
    );
    if (enrollmentId && pausedStep) {
      const waitMs = parseWaitDurationMs(pausedStep.output);
      if (waitMs && waitMs > 0) {
        const maxWaitMs = 7 * 24 * 60 * 60_000;
        const delayMs = Math.min(waitMs, maxWaitMs);
        const scheduledEnrollmentId = enrollmentId;
        clearWorkflowWaitTimer(scheduledEnrollmentId);
        const timer = setTimeout(async () => {
          workflowWaitTimers.delete(scheduledEnrollmentId);
          try {
            await advanceWorkflowEnrollment({
              workflowId: workflow.id,
              enrollmentId: scheduledEnrollmentId,
              resolvedLocationId,
              ignoreSendWindow: undefined,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Onbekende fout";
            console.error("Workflow auto-advance fout:", message);
          }
        }, delayMs);
        workflowWaitTimers.set(scheduledEnrollmentId, timer);
      }
    }

    res.json(report);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflows/:id/enrollments/:enrollmentId/advance", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body ?? {});
    const resolvedLocationId = body.locationId
      ? getGhlConfig(body.locationId).locationId
      : undefined;
    const workflow = await getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow niet gevonden." });
      return;
    }
    const enrollment = await getWorkflowEnrollment(workflow.id, req.params.enrollmentId);
    if (!enrollment) {
      res.status(404).json({ error: "Enrollment niet gevonden." });
      return;
    }
    const result = await advanceWorkflowEnrollment({
      workflowId: workflow.id,
      enrollmentId: enrollment.id,
      resolvedLocationId,
      ignoreSendWindow: true,
    });
    if (!result.report) {
      res.json({
        success: true,
        message: result.message,
        enrollment: result.enrollment,
      });
      return;
    }
    res.json({
      success: true,
      report: result.report,
      enrollment: result.enrollment,
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workflows/:id/enrollments/:enrollmentId", async (req, res, next) => {
  try {
    const workflow = await getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow niet gevonden." });
      return;
    }
    const deleted = await deleteWorkflowEnrollment(workflow.id, req.params.enrollmentId);
    if (!deleted) {
      res.status(404).json({ error: "Enrollment niet gevonden." });
      return;
    }
    clearWorkflowWaitTimer(req.params.enrollmentId);
    await deactivateWorkflowAgentSessionsByEnrollment(workflow.id, req.params.enrollmentId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
  });
  try {
    const query = schema.parse(req.query);
    const config = getGhlConfig(query.locationId);
    const agents = await listAgents(config.locationId);
    res.json({ agents });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    active: z.boolean().optional(),
    settings: z.record(z.unknown()).optional(),
    changeNote: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body);
    const config = getGhlConfig(body.locationId);
    const agent = await createAgent({
      locationId: config.locationId,
      name: body.name,
      description: body.description,
      active: body.active,
      settings: sanitizeAgentSettings({
        ...(body.settings ?? {}),
        name: body.name,
        description: body.description,
        active: body.active,
      }),
      changeNote: body.changeNote,
    });
    res.json({ agent });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/stats", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    days: z.string().optional(),
  });
  try {
    const query = schema.parse(req.query);
    const config = getGhlConfig(query.locationId);
    const daysRaw = Number(query.days ?? "30");
    const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.round(daysRaw))) : 30;
    const stats = await getAgentStats(config.locationId, days);
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/handoffs", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    limit: z.string().optional(),
  });
  try {
    const query = schema.parse(req.query);
    const config = getGhlConfig(query.locationId);
    const limitRaw = Number(query.limit ?? "100");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.round(limitRaw))) : 100;
    const handoffs = await listHandoffs(config.locationId, limit);
    res.json({ handoffs });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/evals/cases", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
  });
  try {
    const query = schema.parse(req.query);
    const config = getGhlConfig(query.locationId);
    const cases = await listEvalCases(config.locationId);
    res.json({ cases });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/evals/cases", async (req, res, next) => {
  const schema = z.object({
    id: z.string().optional(),
    locationId: z.string().optional(),
    title: z.string().min(1),
    payload: z.object({
      leadName: z.string().optional(),
      channel: z.enum(["SMS", "EMAIL"]).optional(),
      history: z.array(
        z.object({
          role: z.enum(["lead", "agent"]),
          text: z.string().min(1),
        })
      ),
    }),
    expected: z.object({
      mustInclude: z.array(z.string()).optional(),
      mustNotInclude: z.array(z.string()).optional(),
      maxSentences: z.number().int().positive().optional(),
    }),
    active: z.boolean().optional(),
  });
  try {
    const body = schema.parse(req.body);
    const config = getGhlConfig(body.locationId);
    const row = await upsertEvalCase({
      id: body.id,
      locationId: config.locationId,
      title: body.title,
      payload: body.payload,
      expected: body.expected,
      active: body.active,
    });
    res.json({ case: row });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/agents/evals/cases/:id", async (req, res, next) => {
  try {
    await deleteEvalCase(req.params.id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/evals/runs", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    limit: z.string().optional(),
  });
  try {
    const query = schema.parse(req.query);
    const config = getGhlConfig(query.locationId);
    const limitRaw = Number(query.limit ?? "100");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.round(limitRaw))) : 100;
    const runs = await listEvalRuns(config.locationId, limit);
    res.json({ runs });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/agents/knowledge/:knowledgeId", async (req, res, next) => {
  try {
    await deleteKnowledgeEntry(req.params.knowledgeId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/knowledge/:knowledgeId/refresh", async (req, res, next) => {
  try {
    const entry = await refreshWebsiteKnowledgeEntry(req.params.knowledgeId);
    res.json({ entry });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/:agentId/versions", async (req, res, next) => {
  try {
    const versions = await listAgentVersions(req.params.agentId);
    res.json({ versions });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:agentId/publish", async (req, res, next) => {
  const schema = z.object({ note: z.string().optional() });
  try {
    const body = schema.parse(req.body ?? {});
    const agent = await publishAgent(req.params.agentId, body.note);
    if (!agent) {
      res.status(404).json({ error: "Agent niet gevonden." });
      return;
    }
    res.json({ agent });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:agentId/rollback", async (req, res, next) => {
  const schema = z.object({
    version: z.number().int().positive(),
    publish: z.boolean().optional(),
    note: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body);
    const agent = await rollbackAgent(req.params.agentId, body.version, {
      publish: body.publish,
      note: body.note,
    });
    if (!agent) {
      res.status(404).json({ error: "Agent of versie niet gevonden." });
      return;
    }
    res.json({ agent });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/:agentId/knowledge", async (req, res, next) => {
  try {
    const knowledge = await listKnowledge(req.params.agentId);
    res.json({ knowledge });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:agentId/knowledge/note", async (req, res, next) => {
  const schema = z.object({
    title: z.string().optional(),
    content: z.string().min(1),
    sourceType: z.enum(["note", "file"]).optional(),
  });
  try {
    const body = schema.parse(req.body);
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent niet gevonden." });
      return;
    }
    const entry = await upsertKnowledgeNote({
      agentId: agent.id,
      locationId: agent.locationId,
      title: body.title,
      content: body.content,
      sourceType: body.sourceType,
    });
    res.json({ entry });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:agentId/knowledge/refresh-all", async (req, res, next) => {
  try {
    const entries = await refreshAgentWebsiteKnowledge(req.params.agentId);
    res.json({ entries });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/:agentId/evals/run", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    caseIds: z.array(z.string()).optional(),
    includeDefaultsWhenEmpty: z.boolean().optional(),
  });
  try {
    const body = schema.parse(req.body ?? {});
    const agentRecord = await getAgent(req.params.agentId);
    if (!agentRecord) {
      res.status(404).json({ error: "Agent niet gevonden." });
      return;
    }

    const config = getGhlConfig(body.locationId ?? agentRecord.locationId);
    const resolvedSettings = await getResolvedAgentSettings(agentRecord.id);
    if (!resolvedSettings) {
      res.status(404).json({ error: "Agent instellingen niet gevonden." });
      return;
    }

    const storedCases = await listEvalCases(config.locationId);
    const activeCases = (storedCases as Array<any>).filter((item) => item.active !== false);
    const selectedCases =
      body.caseIds && body.caseIds.length > 0
        ? activeCases.filter((item) => body.caseIds!.includes(String(item.id)))
        : activeCases;

    const fallbackCases =
      selectedCases.length === 0 && body.includeDefaultsWhenEmpty !== false
        ? DEFAULT_EVAL_CASES
        : [];

    const executionCases: Array<{
      id?: string;
      title: string;
      payload: EvalCasePayload["payload"];
      expected: EvalCasePayload["expected"];
    }> = [
      ...selectedCases.map((item) => ({
        id: String(item.id),
        title: String(item.title),
        payload: item.payload as EvalCasePayload["payload"],
        expected: item.expected as EvalCasePayload["expected"],
      })),
      ...fallbackCases,
    ];

    const results: Array<{
      id?: string;
      title: string;
      passed: boolean;
      score: number;
      output: string;
      feedback: string;
    }> = [];

    for (const currentCase of executionCases) {
      const now = Date.now();
      const messages = currentCase.payload.history.map((item, index) => ({
        id: `eval-${index}-${now}`,
        conversationId: `eval-convo-${agentRecord.id}`,
        contactId: `eval-contact-${agentRecord.id}`,
        type: currentCase.payload.channel === "EMAIL" ? "TYPE_EMAIL" : "TYPE_SMS",
        direction: item.role === "lead" ? "inbound" : "outbound",
        body: item.text,
        timestamp: new Date(now - (currentCase.payload.history.length - index) * 45_000).toISOString(),
      }));

      const evalNameParts = splitNameParts(currentCase.payload.leadName ?? "Eval lead");
      const suggestion = await suggestReply({
        contact: {
          id: `eval-contact-${agentRecord.id}`,
          firstName: evalNameParts.firstName ?? "Eval",
          lastName: evalNameParts.lastName ?? "lead",
          source: "ai-eval",
        },
        conversation: {
          id: `eval-convo-${agentRecord.id}`,
          source: "ai-eval",
          channel: currentCase.payload.channel ?? "SMS",
          dateAdded: new Date(now - 120_000).toISOString(),
          dateUpdated: new Date(now).toISOString(),
        },
        messages,
        maxMessages: messages.length,
        agent: resolvedSettings as any,
      });

      const output = String(suggestion.text ?? "").trim();
      const lowerOutput = output.toLowerCase();
      const mustInclude = (currentCase.expected.mustInclude ?? []).map((item) => item.toLowerCase().trim()).filter(Boolean);
      const mustNotInclude = (currentCase.expected.mustNotInclude ?? []).map((item) => item.toLowerCase().trim()).filter(Boolean);
      const maxSentences = currentCase.expected.maxSentences;

      const includeMatches = mustInclude.filter((item) => lowerOutput.includes(item));
      const includeScore = mustInclude.length ? includeMatches.length / mustInclude.length : 1;
      const forbiddenHits = mustNotInclude.filter((item) => lowerOutput.includes(item));
      const forbiddenScore = mustNotInclude.length ? 1 - forbiddenHits.length / mustNotInclude.length : 1;
      const sentenceCount = countSentences(output);
      const sentenceScore = maxSentences ? (sentenceCount <= maxSentences ? 1 : 0) : 1;
      const score = Number(((includeScore + forbiddenScore + sentenceScore) / 3).toFixed(4));
      const passed = score >= 0.99;

      const feedbackParts: string[] = [];
      if (mustInclude.length && includeMatches.length !== mustInclude.length) {
        feedbackParts.push(`Missende termen: ${mustInclude.filter((item) => !includeMatches.includes(item)).join(", ")}`);
      }
      if (forbiddenHits.length) {
        feedbackParts.push(`Verboden termen gevonden: ${forbiddenHits.join(", ")}`);
      }
      if (maxSentences && sentenceCount > maxSentences) {
        feedbackParts.push(`Te lang: ${sentenceCount} zinnen (max ${maxSentences})`);
      }
      const feedback = feedbackParts.length ? feedbackParts.join(" | ") : "Geslaagd";

      await recordEvalRun({
        locationId: config.locationId,
        agentId: agentRecord.id,
        caseId: currentCase.id,
        passed,
        score,
        feedback,
        output,
      });

      results.push({
        id: currentCase.id,
        title: currentCase.title,
        passed,
        score,
        output,
        feedback,
      });
    }

    const passedCount = results.filter((item) => item.passed).length;
    const averageScore = results.length
      ? Number((results.reduce((sum, item) => sum + item.score, 0) / results.length).toFixed(4))
      : 0;

    res.json({
      summary: {
        total: results.length,
        passed: passedCount,
        failed: results.length - passedCount,
        averageScore,
      },
      results,
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/agents/:agentId", async (req, res, next) => {
  const schema = z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    settings: z.record(z.unknown()).optional(),
    changeNote: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body);
    const agent = await updateAgent(req.params.agentId, {
      name: body.name,
      description: body.description,
      active: body.active,
      settings: body.settings ? sanitizeAgentSettings(body.settings) : undefined,
      changeNote: body.changeNote,
    });
    if (!agent) {
      res.status(404).json({ error: "Agent niet gevonden." });
      return;
    }
    res.json({ agent });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/agents/:agentId", async (req, res, next) => {
  try {
    await archiveAgent(req.params.agentId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mailgun/status", async (req, res, next) => {
  const schema = z.object({ email: z.string().optional(), phone: z.string().optional() });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { email, phone } = schema.parse(req.query);
    const normalizedEmail = email ? email.toLowerCase() : undefined;
    const normalizedPhone = phone ? phone.replace(/\D/g, "") : undefined;
    if (!normalizedEmail && !normalizedPhone) {
      res.json({ data: [] });
      return;
    }
    const { data, error } = await supabase
      .from("mail_events")
      .select("*")
      .eq("to_email", email)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mailgun/inbox", async (req, res, next) => {
  const schema = z.object({ email: z.string().optional(), phone: z.string().optional() });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { email, phone } = schema.parse(req.query);
    const normalizedEmail = email ? email.toLowerCase() : undefined;
    const normalizedPhone = phone ? phone.replace(/\D/g, "") : undefined;
    if (!normalizedEmail && !normalizedPhone) {
      res.json({ data: [] });
      return;
    }
    const { data, error } = await supabase
      .from("mail_inbound")
      .select("*")
      .or(`from_email.eq.${normalizedEmail},from_email.ilike.%${normalizedEmail}%`)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mailgun/thread", async (req, res, next) => {
  const schema = z.object({ email: z.string().optional(), phone: z.string().optional() });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { email, phone } = schema.parse(req.query);
    const normalizedEmail = email ? email.toLowerCase() : undefined;
    const normalizedPhone = phone ? phone.replace(/\D/g, "") : undefined;
    if (!normalizedEmail && !normalizedPhone) {
      res.json({ data: [] });
      return;
    }

    const [{ data: outbound, error: outboundError }, { data: inbound, error: inboundError }, { data: smsOut, error: smsOutError }, { data: smsIn, error: smsInError }] = await Promise.all([
      supabase
        .from("mail_events")
        .select("id, to_email, from_email, subject, created_at, metadata, provider_id")
        .or(
          normalizedEmail
            ? `to_email.eq.${normalizedEmail},to_email.ilike.%${normalizedEmail}%`
            : "id.is.null"
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("mail_inbound")
        .select("id, from_email, to_email, subject, body_plain, body_html, created_at, timestamp")
        .or(
          normalizedEmail
            ? `from_email.eq.${normalizedEmail},from_email.ilike.%${normalizedEmail}%`
            : "id.is.null"
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("sms_events")
        .select("id, to_phone, from_phone, body, created_at, provider_id")
        .or(normalizedPhone ? `to_phone.ilike.%${normalizedPhone}%` : "id.is.null")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("sms_inbound")
        .select("id, from_phone, to_phone, body, created_at, timestamp")
        .or(normalizedPhone ? `from_phone.ilike.%${normalizedPhone}%` : "id.is.null")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    if (outboundError) throw outboundError;
    if (inboundError) throw inboundError;
    if (smsOutError) throw smsOutError;
    if (smsInError) throw smsInError;

    const outboundMessages = (outbound ?? []).map((item) => ({
      id: item.id,
      direction: "outbound",
      from_email: item.from_email,
      to_email: item.to_email,
      subject: item.subject,
      body: (item.metadata && (item.metadata.text || item.metadata.body)) || "",
      timestamp: item.created_at,
      provider_id: item.provider_id ?? null,
    }));

    const inboundMessages = (inbound ?? []).map((item) => ({
      id: item.id,
      direction: "inbound",
      from_email: item.from_email,
      to_email: item.to_email,
      subject: item.subject,
      body: cleanEmailReply(item.body_plain) || item.body_plain || "",
      timestamp: item.timestamp || item.created_at,
      provider_id: null,
    }));

    const smsOutMessages = (smsOut ?? []).map((item) => ({
      id: item.id,
      direction: "outbound",
      from_phone: item.from_phone,
      to_phone: item.to_phone,
      subject: "SMS",
      body: item.body || "",
      timestamp: item.created_at,
      provider_id: item.provider_id ?? null,
      type: "SMS",
    }));

    const smsInMessages = (smsIn ?? []).map((item) => ({
      id: item.id,
      direction: "inbound",
      from_phone: item.from_phone,
      to_phone: item.to_phone,
      subject: "SMS",
      body: item.body || "",
      timestamp: item.timestamp || item.created_at,
      provider_id: null,
      type: "SMS",
    }));

    const data = [...outboundMessages, ...inboundMessages, ...smsOutMessages, ...smsInMessages].sort((a, b) => {
      const at = new Date(a.timestamp ?? 0).getTime();
      const bt = new Date(b.timestamp ?? 0).getTime();
      return at - bt;
    });

    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/crm/leads", async (req, res, next) => {
  const schema = z.object({
    status: z.string().optional(),
    q: z.string().optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { status, q, limit, offset } = schema.parse(req.query);
    const take = limit ? Math.min(Number(limit), 100) : 50;
    const skip = offset ? Math.max(Number(offset), 0) : 0;
    const view = "crm_leads_activity";
    let query = supabase
      .from(view)
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(skip, skip + take - 1);

    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      query = query.or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`);
    }

    const { data, error, count } = await query;
    if (error) {
      if (error.code === "42P01" || error.message?.includes("does not exist")) {
        throw new Error("CRM views ontbreken. Run server/db/crm.sql in Supabase.");
      }
      throw new Error(error.message);
    }

    let filtered = data ?? [];
    if (status === "open") {
      filtered = filtered.filter((lead) => {
        if (!lead.last_outbound_at) return false;
        if (!lead.last_inbound_at) return true;
        return new Date(lead.last_inbound_at).getTime() < new Date(lead.last_outbound_at).getTime();
      });
    } else if (status === "replied") {
      filtered = filtered.filter((lead) => {
        if (!lead.last_inbound_at) return false;
        if (!lead.last_outbound_at) return true;
        return new Date(lead.last_inbound_at).getTime() >= new Date(lead.last_outbound_at).getTime();
      });
    }

    res.json({ data: filtered, total: count ?? filtered.length });
  } catch (error) {
    next(error);
  }
});

app.post("/api/crm/leads", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    status: z.string().optional(),
    owner: z.string().optional(),
    source: z.string().optional(),
    pipelineStage: z.string().optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const body = schema.parse(req.body);
    const { data, error } = await supabase
      .from("crm_leads")
      .insert({
        name: body.name,
        email: body.email ? body.email.toLowerCase() : null,
        phone: body.phone ?? null,
        status: body.status ?? "Nieuw",
        owner: body.owner ?? "Onbekend",
        source: body.source ?? null,
        pipeline_stage: body.pipelineStage ?? null,
      })
      .select("*")
      .single();
    if (error) {
      throw new Error(error.message);
    }
    res.json({ lead: data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/crm/auto-reply-rules", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { data, error } = await supabase
      .from("auto_reply_rules")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ data: data ?? [] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/crm/auto-reply-rules", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    channel: z.enum(["email", "sms", "both"]).optional(),
    enabled: z.boolean().optional(),
    delayMinutes: z.number().int().nonnegative().optional(),
    businessHoursOnly: z.boolean().optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const body = schema.parse(req.body);
    const { data, error } = await supabase
      .from("auto_reply_rules")
      .insert({
        name: body.name,
        prompt: body.prompt,
        channel: body.channel ?? "both",
        enabled: body.enabled ?? true,
        delay_minutes: body.delayMinutes ?? 0,
        business_hours_only: body.businessHoursOnly ?? false,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    res.json({ rule: data });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/crm/auto-reply-rules/:id", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    channel: z.enum(["email", "sms", "both"]).optional(),
    enabled: z.boolean().optional(),
    delayMinutes: z.number().int().nonnegative().optional(),
    businessHoursOnly: z.boolean().optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const body = schema.parse(req.body);
    const payload: Record<string, unknown> = {};
    if (body.name !== undefined) payload.name = body.name;
    if (body.prompt !== undefined) payload.prompt = body.prompt;
    if (body.channel !== undefined) payload.channel = body.channel;
    if (body.enabled !== undefined) payload.enabled = body.enabled;
    if (body.delayMinutes !== undefined) payload.delay_minutes = body.delayMinutes;
    if (body.businessHoursOnly !== undefined)
      payload.business_hours_only = body.businessHoursOnly;
    const { data, error } = await supabase
      .from("auto_reply_rules")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    res.json({ rule: data });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/crm/auto-reply-rules/:id", async (req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const { error } = await supabase.from("auto_reply_rules").delete().eq("id", id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/crm/automations", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { data, error } = await supabase
      .from("crm_automations")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ data: data ?? [] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/crm/automations", async (req, res, next) => {
  const stepSchema = z.object({
    id: z.string().optional(),
    type: z.enum(["trigger", "wait", "email", "sms"]),
    config: z.record(z.unknown()).optional(),
  });
  const schema = z.object({
    name: z.string().min(1),
    triggerType: z.string().optional(),
    triggerValue: z.string().optional(),
    channel: z.enum(["email", "sms", "both"]).optional(),
    emailSubject: z.string().optional(),
    emailBody: z.string().optional(),
    smsBody: z.string().optional(),
    delayMinutes: z.number().int().nonnegative().optional(),
    businessHoursOnly: z.boolean().optional(),
    enabled: z.boolean().optional(),
    steps: z.array(stepSchema).optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const body = schema.parse(req.body);
    const { data, error } = await supabase
      .from("crm_automations")
      .insert({
        name: body.name,
        trigger_type: body.triggerType ?? "stage",
        trigger_value: body.triggerValue ?? null,
        channel: body.channel ?? "both",
        email_subject: body.emailSubject ?? null,
        email_body: body.emailBody ?? null,
        sms_body: body.smsBody ?? null,
        delay_minutes: body.delayMinutes ?? 0,
        business_hours_only: body.businessHoursOnly ?? false,
        enabled: body.enabled ?? true,
        steps: body.steps ?? [],
      })
      .select("*")
      .single();
    if (error) {
      if (error.message.toLowerCase().includes("steps")) {
        throw new Error(
          "Supabase mist de kolom 'steps'. Run server/db/automations.sql opnieuw."
        );
      }
      throw new Error(error.message);
    }
    res.json({ automation: data });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/crm/automations/:id", async (req, res, next) => {
  const stepSchema = z.object({
    id: z.string().optional(),
    type: z.enum(["trigger", "wait", "email", "sms"]),
    config: z.record(z.unknown()).optional(),
  });
  const schema = z.object({
    name: z.string().min(1).optional(),
    triggerType: z.string().optional(),
    triggerValue: z.string().optional(),
    channel: z.enum(["email", "sms", "both"]).optional(),
    emailSubject: z.string().optional(),
    emailBody: z.string().optional(),
    smsBody: z.string().optional(),
    delayMinutes: z.number().int().nonnegative().optional(),
    businessHoursOnly: z.boolean().optional(),
    enabled: z.boolean().optional(),
    steps: z.array(stepSchema).optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const body = schema.parse(req.body);
    const payload: Record<string, unknown> = {};
    if (body.name !== undefined) payload.name = body.name;
    if (body.triggerType !== undefined) payload.trigger_type = body.triggerType;
    if (body.triggerValue !== undefined) payload.trigger_value = body.triggerValue;
    if (body.channel !== undefined) payload.channel = body.channel;
    if (body.emailSubject !== undefined) payload.email_subject = body.emailSubject;
    if (body.emailBody !== undefined) payload.email_body = body.emailBody;
    if (body.smsBody !== undefined) payload.sms_body = body.smsBody;
    if (body.delayMinutes !== undefined) payload.delay_minutes = body.delayMinutes;
    if (body.businessHoursOnly !== undefined)
      payload.business_hours_only = body.businessHoursOnly;
    if (body.enabled !== undefined) payload.enabled = body.enabled;
    if (body.steps !== undefined) payload.steps = body.steps;

    const { data, error } = await supabase
      .from("crm_automations")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();
    if (error) {
      if (error.message.toLowerCase().includes("steps")) {
        throw new Error(
          "Supabase mist de kolom 'steps'. Run server/db/automations.sql opnieuw."
        );
      }
      throw new Error(error.message);
    }
    res.json({ automation: data });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/crm/automations/:id", async (req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const { error } = await supabase.from("crm_automations").delete().eq("id", id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/crm/leads/:id", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional().nullable(),
    phone: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    owner: z.string().optional().nullable(),
    source: z.string().optional().nullable(),
    pipelineStage: z.string().optional().nullable(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const body = schema.parse(req.body);
    const payload: Record<string, unknown> = {};
    if (body.name !== undefined) payload.name = body.name;
    if (body.email !== undefined)
      payload.email = body.email ? body.email.toLowerCase() : null;
    if (body.phone !== undefined) payload.phone = body.phone ?? null;
    if (body.status !== undefined) payload.status = body.status ?? null;
    if (body.owner !== undefined) payload.owner = body.owner ?? null;
    if (body.source !== undefined) payload.source = body.source ?? null;
    if (body.pipelineStage !== undefined)
      payload.pipeline_stage = body.pipelineStage ?? null;

    const { data, error } = await supabase
      .from("crm_leads")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();
    if (error) {
      throw new Error(error.message);
    }
    res.json({ lead: data });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mailgun/suggest", async (req, res, next) => {
  const schema = z.object({
    email: z.string().email().optional().nullable().or(z.literal("")),
    channel: z.enum(["email", "sms"]).optional(),
    lead: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email().optional().nullable().or(z.literal("")),
      phone: z.string().optional().nullable(),
      status: z.string().optional().nullable(),
      owner: z.string().optional().nullable(),
      createdAt: z.string().optional().nullable(),
      source: z.string().optional().nullable(),
      pipelineStage: z.string().optional().nullable(),
    }),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }

    const body = schema.parse(req.body);
    const targetEmail = (body.email ?? body.lead.email ?? "")
      .toLowerCase()
      .trim();
    const targetPhone = body.lead.phone ? body.lead.phone.replace(/\D/g, "") : "";
    if (!targetEmail && !targetPhone) {
      res.status(400).json({ error: "Missing lead email or phone." });
      return;
    }

    const [{ data: outbound, error: outboundError }, { data: inbound, error: inboundError }, { data: smsOut, error: smsOutError }, { data: smsIn, error: smsInError }] = await Promise.all([
      supabase
        .from("mail_events")
        .select("id, to_email, from_email, subject, created_at, metadata, provider_id")
        .or(
          targetEmail
            ? `to_email.eq.${targetEmail},to_email.ilike.%${targetEmail}%`
            : "id.is.null"
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("mail_inbound")
        .select("id, from_email, to_email, subject, body_plain, body_html, created_at, timestamp")
        .or(
          targetEmail
            ? `from_email.eq.${targetEmail},from_email.ilike.%${targetEmail}%`
            : "id.is.null"
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("sms_events")
        .select("id, to_phone, from_phone, body, created_at, provider_id")
        .or(targetPhone ? `to_phone.ilike.%${targetPhone}%` : "id.is.null")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("sms_inbound")
        .select("id, from_phone, to_phone, body, created_at, timestamp")
        .or(targetPhone ? `from_phone.ilike.%${targetPhone}%` : "id.is.null")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    if (outboundError) throw outboundError;
    if (inboundError) throw inboundError;
    if (smsOutError) throw smsOutError;
    if (smsInError) throw smsInError;

    const outboundMessages = (outbound ?? []).map((item) => ({
      id: item.id,
      direction: "outbound",
      body: (item.metadata && (item.metadata.text || item.metadata.body)) || "",
      subject: item.subject,
      timestamp: item.created_at,
      type: "EMAIL",
    }));

    const inboundMessages = (inbound ?? []).map((item) => ({
      id: item.id,
      direction: "inbound",
      body: cleanEmailReply(item.body_plain) || item.body_plain || "",
      subject: item.subject,
      timestamp: item.timestamp || item.created_at,
      type: "EMAIL",
    }));

    const smsOutMessages = (smsOut ?? []).map((item) => ({
      id: item.id,
      direction: "outbound",
      body: item.body || "",
      subject: "SMS",
      timestamp: item.created_at,
      type: "SMS",
    }));

    const smsInMessages = (smsIn ?? []).map((item) => ({
      id: item.id,
      direction: "inbound",
      body: item.body || "",
      subject: "SMS",
      timestamp: item.timestamp || item.created_at,
      type: "SMS",
    }));

    const messages = [...outboundMessages, ...inboundMessages, ...smsOutMessages, ...smsInMessages].sort((a, b) => {
      const at = new Date(a.timestamp ?? 0).getTime();
      const bt = new Date(b.timestamp ?? 0).getTime();
      return at - bt;
    });

    const { data: rules, error: rulesError } = await supabase
      .from("auto_reply_rules")
      .select("*")
      .eq("enabled", true);
    if (rulesError) {
      throw new Error(rulesError.message);
    }

    const channel = body.channel ?? "email";
    const filteredRules =
      rules?.filter((rule) => rule.channel === "both" || rule.channel === channel) ?? [];

    const lead = {
      ...body.lead,
      email: body.lead.email && body.lead.email.trim() ? body.lead.email : undefined,
      phone: body.lead.phone ?? undefined,
      status: body.lead.status ?? undefined,
      owner: body.lead.owner ?? undefined,
      createdAt: body.lead.createdAt ?? undefined,
      source: body.lead.source ?? undefined,
      pipelineStage: body.lead.pipelineStage ?? undefined,
    };

    const suggestion = await suggestCrmReply({
      lead,
      messages,
      rules: filteredRules,
      channel,
    });
    res.json(suggestion);
  } catch (error) {
    next(error);
  }
});

const parseTimestampToIso = (value?: string | null) => {
  if (!value) return new Date().toISOString();
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return new Date(asNumber * 1000).toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
};

const directionLooksInbound = (direction?: string | null) =>
  String(direction ?? "").toLowerCase().includes("in");

const messageTypeMatchesChannel = (type: string | undefined, channel: "SMS" | "EMAIL") => {
  const normalized = String(type ?? "").toLowerCase();
  if (!normalized) return true;
  if (channel === "SMS") {
    return normalized.includes("sms") || normalized.includes("text");
  }
  return normalized.includes("email") || normalized.includes("mail");
};

const splitNameParts = (fullName?: string | null) => {
  const cleaned = (fullName ?? "").trim().replace(/\s+/g, " ");
  if (!cleaned) return { firstName: undefined, lastName: undefined };
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 0) return { firstName: undefined, lastName: undefined };
  if (parts.length === 1) return { firstName: parts[0], lastName: undefined };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
};

const ingestInboundSmsAndAutoReply = async (input: {
  provider?: string;
  messageId?: string | null;
  fromPhone?: string | null;
  toPhone?: string | null;
  body?: string | null;
  timestamp?: string | null;
  raw?: Record<string, unknown> | null;
}) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("Supabase not configured.");
  }

  const messageId = input.messageId?.trim() || null;
  if (messageId) {
    const { data: existing, error: existingError } = await supabase
      .from("sms_inbound")
      .select("id")
      .eq("message_id", messageId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing?.id) {
      return {
        inserted: false,
        duplicate: true,
        autoReply: { handled: false, reason: "duplicate_message_id" as const },
      };
    }
  }

  const record = {
    provider: input.provider ?? "twilio",
    message_id: messageId,
    from_phone: input.fromPhone ?? null,
    to_phone: input.toPhone ?? null,
    body: input.body ?? null,
    timestamp: input.timestamp ?? null,
    raw: input.raw ?? null,
  };

  const { error } = await supabase.from("sms_inbound").insert(record);
  if (error) throw error;

  const autoReply = TWILIO_WORKFLOW_AGENT_AUTOREPLY_ENABLED
    ? await runWorkflowAgentAutoReplyForInboundSms({
        fromPhone: input.fromPhone,
        toPhone: input.toPhone,
        body: input.body,
        timestamp: input.timestamp,
      })
    : { handled: false, reason: "twilio_workflow_autoreply_disabled" as const };
  return { inserted: true, duplicate: false, autoReply };
};

const runWorkflowAgentAutoReplyForInboundSms = async (input: {
  fromPhone?: string | null;
  toPhone?: string | null;
  body?: string | null;
  timestamp?: string | null;
}) => {
  const fromPhone = input.fromPhone?.trim();
  const inboundBody = input.body?.trim();
  if (!fromPhone || !inboundBody) {
    return { handled: false, reason: "missing_from_or_body" as const };
  }

  const session = await findActiveWorkflowAgentSessionForInbound({
    fromPhone,
    toPhone: input.toPhone ?? undefined,
  });
  if (!session) {
    return { handled: false, reason: "no_workflow_session" as const };
  }
  if (!session.leadPhone || !session.leadPhoneNorm) {
    return { handled: false, reason: "session_missing_lead_phone" as const, sessionId: session.id };
  }
  const inboundAt = parseTimestampToIso(input.timestamp);
  const inboundAtMs = Date.parse(inboundAt);
  const activatedAtMs = Date.parse(session.activatedAt);
  const logEvent = async (
    eventType: string,
    level: "info" | "warn" | "error",
    message: string,
    payload?: Record<string, unknown>
  ) => {
    await recordWorkflowAgentEvent({
      workflowId: session.workflowId,
      sessionId: session.id,
      enrollmentId: session.enrollmentId ?? undefined,
      eventType,
      level,
      message,
      payload,
    }).catch(() => undefined);
  };

  try {
    if (
      Number.isFinite(inboundAtMs) &&
      Number.isFinite(activatedAtMs) &&
      inboundAtMs < activatedAtMs - 15_000
    ) {
      await logEvent(
        "auto_reply_skipped",
        "info",
        "Inbound bericht is ouder dan de actieve agent sessie.",
        {
          inboundAt,
          activatedAt: session.activatedAt,
        }
      );
      return {
        handled: false,
        reason: "inbound_before_session_activation" as const,
        sessionId: session.id,
      };
    }

    await logEvent("inbound_received", "info", "Inbound SMS ontvangen voor agent sessie.", {
      fromPhone,
      toPhone: input.toPhone ?? undefined,
      bodyPreview: inboundBody.slice(0, 240),
      inboundAt,
    });

    const agent = await getAgent(session.agentId);
    if (!agent || !agent.active) {
      await logEvent("auto_reply_skipped", "warn", "Auto-reply overgeslagen: agent is niet actief.");
      return { handled: false, reason: "agent_inactive" as const, sessionId: session.id };
    }
    const settings = await getResolvedAgentSettings(session.agentId);
    if (!settings) {
      await logEvent("auto_reply_skipped", "warn", "Auto-reply overgeslagen: agent settings ontbreken.");
      return { handled: false, reason: "agent_settings_missing" as const, sessionId: session.id };
    }

    await touchWorkflowAgentSessionInbound(session.id, inboundAt);
    await updateWorkflowAgentSessionFollowUpState(session.id, {
      followUpStep: 0,
      nextFollowUpAt: null,
      lastFollowUpAt: null,
    }).catch(() => undefined);

    const supabase = getSupabaseClient();
    if (!supabase) {
      throw new Error("Supabase not configured.");
    }

    const leadPhoneNorm = session.leadPhoneNorm;
    const [{ data: outbound, error: outboundError }, { data: inbound, error: inboundError }] =
      await Promise.all([
        supabase
          .from("sms_events")
          .select("id, to_phone, from_phone, body, created_at")
          .or(`to_phone.ilike.%${leadPhoneNorm}%`)
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("sms_inbound")
          .select("id, from_phone, to_phone, body, created_at, timestamp")
          .or(`from_phone.ilike.%${leadPhoneNorm}%`)
          .order("created_at", { ascending: false })
          .limit(200),
      ]);
    if (outboundError) throw outboundError;
    if (inboundError) throw inboundError;

    const filteredOutbound = (outbound ?? []).filter((item) => {
      const leadMatches = phonesLikelyMatch(item.to_phone, session.leadPhone);
      if (!leadMatches) return false;
      if (!session.twilioToPhone) return true;
      return phonesLikelyMatch(item.from_phone, session.twilioToPhone);
    });
    const filteredInbound = (inbound ?? []).filter((item) => {
      const leadMatches = phonesLikelyMatch(item.from_phone, session.leadPhone);
      if (!leadMatches) return false;
      if (!session.twilioToPhone) return true;
      return phonesLikelyMatch(item.to_phone, session.twilioToPhone);
    });

    const conversationId = `workflow-agent-session-${session.id}`;
    const contactId = `workflow-lead-${normalizePhoneDigits(session.leadPhone) ?? session.id}`;
    const messages = [
      ...filteredOutbound.map((item) => ({
        id: `sms-out-${item.id}`,
        conversationId,
        contactId,
        type: "TYPE_SMS",
        direction: "outbound",
        body: String(item.body ?? ""),
        timestamp: String(item.created_at ?? new Date().toISOString()),
      })),
      ...filteredInbound.map((item) => ({
        id: `sms-in-${item.id}`,
        conversationId,
        contactId,
        type: "TYPE_SMS",
        direction: "inbound",
        body: String(item.body ?? ""),
        timestamp: parseTimestampToIso((item as { timestamp?: string | null }).timestamp ?? item.created_at),
      })),
    ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (messages.length === 0) {
      messages.push({
        id: `sms-in-fallback-${Date.now()}`,
        conversationId,
        contactId,
        type: "TYPE_SMS",
        direction: "inbound",
        body: inboundBody,
        timestamp: inboundAt,
      });
    }

    const sessionNameParts = splitNameParts(session.leadName);
    const suggestion = await suggestReply({
      contact: {
        id: contactId,
        firstName: sessionNameParts.firstName ?? "Lead",
        lastName: sessionNameParts.lastName ?? undefined,
        email: session.leadEmail ?? undefined,
        phone: session.leadPhone,
        source: "workflow-agent-session",
        dateAdded: session.activatedAt,
      },
      conversation: {
        id: conversationId,
        channel: "SMS",
        source: "workflow-agent-session",
        dateAdded: session.activatedAt,
        dateUpdated: inboundAt,
      },
      messages,
      maxMessages: 200,
      agent: settings as any,
    });
    let stageUpdate:
      | {
          marked: boolean;
          reason?: string;
          outcomeReason?: string;
          contactId?: string;
          stageName?: string;
          outcome?: AgentOutcomeType;
          opportunityId?: string;
        }
      | undefined;
    if (session.locationId) {
      try {
        const config = getGhlConfig(session.locationId);
        stageUpdate = await maybeMarkOpportunityStageFromAgentOutcome({
          config,
          leadPhone: session.leadPhone,
          policy: (suggestion as { policy?: AgentPolicyMeta })?.policy,
          lastInboundText: inboundBody,
          messages,
          agentSettings: (settings as Record<string, unknown>) ?? undefined,
        });
      } catch (error) {
        stageUpdate = {
          marked: false,
          reason: error instanceof Error ? error.message : "stage_update_failed",
        };
      }
      if (stageUpdate?.marked) {
        await logEvent("opportunity_stage_marked", "info", "Opportunity stage aangepast door AI agent.", {
          outcome: stageUpdate.outcome,
          outcomeReason: stageUpdate.outcomeReason ?? null,
          stageName: stageUpdate.stageName,
          contactId: stageUpdate.contactId,
          opportunityId: stageUpdate.opportunityId,
        });
      }
    }

    const replyText = suggestion.text?.trim();
    if (!replyText) {
      await logEvent("auto_reply_skipped", "warn", "Auto-reply overgeslagen: lege suggestie.");
      return { handled: false, reason: "empty_suggestion" as const, sessionId: session.id };
    }

    const sms = await sendSmsViaTwilio({ to: session.leadPhone, body: replyText });
    const outboundAt = new Date().toISOString();
    await touchWorkflowAgentSessionOutbound(session.id, outboundAt);
    const followUpPlan = await resetWorkflowAgentFollowUpSchedule({
      sessionId: session.id,
      agentSettings: (settings as Record<string, unknown>) ?? undefined,
      outboundAt,
    }).catch(() => ({
      plan: {
        enabled: false,
        maxFollowUps: 0,
        scheduleHours: [] as number[],
        minDelayMinutes: 0,
        maxDelayMinutes: 0,
      },
      nextFollowUpAt: null as string | null,
    }));
    await recordAgentRun({
      locationId: session.locationId ?? "workflow",
      agentId: session.agentId,
      source: "suggest",
      conversationId,
      contactId,
      channel: "SMS",
      model: suggestion.cost?.model,
      inputTokens: suggestion.usage?.inputTokens,
      outputTokens: suggestion.usage?.outputTokens,
      totalTokens: suggestion.usage?.totalTokens,
      costEur: suggestion.cost?.eur,
      responseMs: undefined,
      promptVersion: agent.currentVersion,
      followUpLimitReached: (suggestion as any).policy?.followUpLimitReached,
      handoffRequired: (suggestion as any).policy?.handoffRequired,
      handoffReason: (suggestion as any).policy?.handoffReason,
      safetyFlags: (suggestion as any).policy?.safetyFlags,
    }).catch(() => undefined);
    await logEvent("auto_reply_sent", "info", "Auto-reply via SMS verzonden.", {
      providerMessageId: sms.sid,
      to: session.leadPhone,
      from: sms.from ?? null,
      bodyPreview: replyText.slice(0, 240),
      stageMarked: stageUpdate?.marked ?? false,
      stageName: stageUpdate?.stageName ?? null,
      markReason: stageUpdate?.reason ?? null,
      outcome: stageUpdate?.outcome ?? null,
      outcomeReason: stageUpdate?.outcomeReason ?? null,
      followUpScheduleHours: followUpPlan.plan.scheduleHours,
      followUpAutoEnabled: followUpPlan.plan.enabled,
      followUpDelayMinMinutes: followUpPlan.plan.minDelayMinutes,
      followUpDelayMaxMinutes: followUpPlan.plan.maxDelayMinutes,
      nextFollowUpAt: followUpPlan.nextFollowUpAt,
    });

    return {
      handled: true,
      sessionId: session.id,
      providerMessageId: sms.sid,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onbekende fout";
    await logEvent("auto_reply_error", "error", message);
    throw error;
  }
};

const runWorkflowAgentAutoReplyForGhlInbound = async (input: {
  session: Awaited<ReturnType<typeof listActiveWorkflowAgentSessions>>[number];
  config: GhlConfig;
  contactId: string;
  conversationId: string;
  inboundMessage: {
    id: string;
    body: string;
    timestamp: string;
    type: string;
  };
  channel: "SMS" | "EMAIL";
}) => {
  const inboundBody = input.inboundMessage.body.trim();
  if (!inboundBody) {
    return { handled: false, reason: "empty_inbound_body" as const, sessionId: input.session.id };
  }
  if (
    input.session.lastInboundMessageId &&
    input.session.lastInboundMessageId === input.inboundMessage.id
  ) {
    return { handled: false, reason: "duplicate_inbound_message" as const, sessionId: input.session.id };
  }

  const inboundAt = parseTimestampToIso(input.inboundMessage.timestamp);
  const inboundAtMs = Date.parse(inboundAt);
  const activatedAtMs = Date.parse(input.session.activatedAt);
  const logEvent = async (
    eventType: string,
    level: "info" | "warn" | "error",
    message: string,
    payload?: Record<string, unknown>
  ) => {
    await recordWorkflowAgentEvent({
      workflowId: input.session.workflowId,
      sessionId: input.session.id,
      enrollmentId: input.session.enrollmentId ?? undefined,
      eventType,
      level,
      message,
      payload,
    }).catch(() => undefined);
  };

  try {
    if (
      Number.isFinite(inboundAtMs) &&
      Number.isFinite(activatedAtMs) &&
      inboundAtMs < activatedAtMs - 15_000
    ) {
      await logEvent(
        "auto_reply_skipped",
        "info",
        "Inbound bericht is ouder dan de actieve agent sessie.",
        {
          inboundAt,
          activatedAt: input.session.activatedAt,
          inboundMessageId: input.inboundMessage.id,
        }
      );
      return {
        handled: false,
        reason: "inbound_before_session_activation" as const,
        sessionId: input.session.id,
      };
    }

    await logEvent("inbound_received", "info", "Inbound bericht ontvangen voor agent sessie.", {
      channel: input.channel,
      conversationId: input.conversationId,
      contactId: input.contactId,
      bodyPreview: inboundBody.slice(0, 240),
      inboundAt,
      inboundMessageId: input.inboundMessage.id,
    });

    const agent = await getAgent(input.session.agentId);
    if (!agent || !agent.active) {
      await logEvent("auto_reply_skipped", "warn", "Auto-reply overgeslagen: agent is niet actief.");
      return { handled: false, reason: "agent_inactive" as const, sessionId: input.session.id };
    }
    const settings = await getResolvedAgentSettings(input.session.agentId);
    if (!settings) {
      await logEvent("auto_reply_skipped", "warn", "Auto-reply overgeslagen: agent settings ontbreken.");
      return { handled: false, reason: "agent_settings_missing" as const, sessionId: input.session.id };
    }

    await touchWorkflowAgentSessionInbound(
      input.session.id,
      inboundAt,
      input.inboundMessage.id
    );
    await updateWorkflowAgentSessionFollowUpState(input.session.id, {
      followUpStep: 0,
      nextFollowUpAt: null,
      lastFollowUpAt: null,
    }).catch(() => undefined);

    const [messages, contact] = await Promise.all([
      listAllMessages(input.config, input.conversationId, 200),
      getContactById(input.config, input.contactId).catch(() => null),
    ]);
    const filteredMessages = messages.filter((message) =>
      messageTypeMatchesChannel(message.type, input.channel)
    );
    const history = filteredMessages.length > 0 ? filteredMessages : messages;

    const sessionNameParts = splitNameParts(input.session.leadName);
    const suggestion = await suggestReply({
      contact: {
        id: input.contactId,
        firstName:
          contact?.firstName ?? sessionNameParts.firstName ?? "Lead",
        lastName: contact?.lastName ?? sessionNameParts.lastName ?? undefined,
        email: contact?.email ?? input.session.leadEmail ?? undefined,
        phone: contact?.phone ?? input.session.leadPhone ?? undefined,
        source: "workflow-agent-session",
        dateAdded: input.session.activatedAt,
      },
      conversation: {
        id: input.conversationId,
        channel: input.channel,
        source: "workflow-agent-session",
        dateAdded: input.session.activatedAt,
        dateUpdated: inboundAt,
      },
      messages: history,
      maxMessages: 200,
      agent: settings as any,
    });
    let stageUpdate:
      | {
          marked: boolean;
          reason?: string;
          outcomeReason?: string;
          contactId?: string;
          stageName?: string;
          outcome?: AgentOutcomeType;
          opportunityId?: string;
        }
      | undefined;
    if (input.session.locationId) {
      try {
        stageUpdate = await maybeMarkOpportunityStageFromAgentOutcome({
          config: input.config,
          contactId: input.contactId,
          leadPhone: input.session.leadPhone,
          leadEmail: input.session.leadEmail,
          policy: (suggestion as { policy?: AgentPolicyMeta })?.policy,
          lastInboundText: inboundBody,
          messages: history,
          agentSettings: (settings as Record<string, unknown>) ?? undefined,
        });
      } catch (error) {
        stageUpdate = {
          marked: false,
          reason: error instanceof Error ? error.message : "stage_update_failed",
        };
      }
      if (stageUpdate?.marked) {
        await logEvent("opportunity_stage_marked", "info", "Opportunity stage aangepast door AI agent.", {
          outcome: stageUpdate.outcome,
          outcomeReason: stageUpdate.outcomeReason ?? null,
          stageName: stageUpdate.stageName,
          contactId: stageUpdate.contactId,
          opportunityId: stageUpdate.opportunityId,
        });
      }
    }

    const replyText = suggestion.text?.trim();
    if (!replyText) {
      await logEvent("auto_reply_skipped", "warn", "Auto-reply overgeslagen: lege suggestie.");
      return { handled: false, reason: "empty_suggestion" as const, sessionId: input.session.id };
    }

    const sendResult = await sendMessage(input.config, {
      contactId: input.contactId,
      conversationId: input.conversationId,
      channel: input.channel,
      body: replyText,
      ...(input.channel === "EMAIL" ? { subject: "Opvolging" } : {}),
      locationId: input.config.locationId,
    });
    const outboundMessageId = sendResult.messageId ?? sendResult.emailMessageId ?? undefined;
    const outboundAt = new Date().toISOString();
    await touchWorkflowAgentSessionOutbound(
      input.session.id,
      outboundAt,
      outboundMessageId
    );
    const refreshedSession = await upsertWorkflowAgentSession({
      workflowId: input.session.workflowId,
      enrollmentId: input.session.enrollmentId ?? undefined,
      locationId: input.session.locationId ?? undefined,
      agentId: input.session.agentId,
      channel: input.channel,
      leadName: input.session.leadName ?? undefined,
      leadEmail: input.session.leadEmail ?? undefined,
      leadPhone: input.session.leadPhone ?? undefined,
      ghlContactId: input.contactId,
      ghlConversationId: input.conversationId,
      lastOutboundAt: outboundAt,
      lastOutboundMessageId: outboundMessageId,
    }).catch(() => null);
    const followUpTargetSessionId = refreshedSession?.id ?? input.session.id;
    const followUpPlan = await resetWorkflowAgentFollowUpSchedule({
      sessionId: followUpTargetSessionId,
      agentSettings: (settings as Record<string, unknown>) ?? undefined,
      outboundAt,
    }).catch(() => ({
      plan: {
        enabled: false,
        maxFollowUps: 0,
        scheduleHours: [] as number[],
        minDelayMinutes: 0,
        maxDelayMinutes: 0,
      },
      nextFollowUpAt: null as string | null,
    }));
    await recordAgentRun({
      locationId: input.session.locationId ?? "workflow",
      agentId: input.session.agentId,
      source: "suggest",
      conversationId: input.conversationId,
      contactId: input.contactId,
      channel: input.channel,
      model: suggestion.cost?.model,
      inputTokens: suggestion.usage?.inputTokens,
      outputTokens: suggestion.usage?.outputTokens,
      totalTokens: suggestion.usage?.totalTokens,
      costEur: suggestion.cost?.eur,
      responseMs: undefined,
      promptVersion: agent.currentVersion,
      followUpLimitReached: (suggestion as any).policy?.followUpLimitReached,
      handoffRequired: (suggestion as any).policy?.handoffRequired,
      handoffReason: (suggestion as any).policy?.handoffReason,
      safetyFlags: (suggestion as any).policy?.safetyFlags,
    }).catch(() => undefined);
    await logEvent("auto_reply_sent", "info", "Auto-reply via GHL verzonden.", {
      channel: input.channel,
      providerMessageId: outboundMessageId ?? null,
      contactId: input.contactId,
      conversationId: input.conversationId,
      bodyPreview: replyText.slice(0, 240),
      stageMarked: stageUpdate?.marked ?? false,
      stageName: stageUpdate?.stageName ?? null,
      markReason: stageUpdate?.reason ?? null,
      outcome: stageUpdate?.outcome ?? null,
      outcomeReason: stageUpdate?.outcomeReason ?? null,
      followUpScheduleHours: followUpPlan.plan.scheduleHours,
      followUpAutoEnabled: followUpPlan.plan.enabled,
      followUpDelayMinMinutes: followUpPlan.plan.minDelayMinutes,
      followUpDelayMaxMinutes: followUpPlan.plan.maxDelayMinutes,
      nextFollowUpAt: followUpPlan.nextFollowUpAt,
    });

    return {
      handled: true,
      sessionId: input.session.id,
      providerMessageId: outboundMessageId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onbekende fout";
    await logEvent("auto_reply_error", "error", message);
    throw error;
  }
};

let ghlAgentInboundPollBusy = false;
const pollGhlAgentInboundMessages = async () => {
  if (ghlAgentInboundPollBusy) return;
  ghlAgentInboundPollBusy = true;
  try {
    const sessions = await listActiveWorkflowAgentSessions(
      GHL_AGENT_INBOUND_SESSIONS_LIMIT
    );
    if (sessions.length === 0) return;
    const baselineMs = Date.now() - GHL_AGENT_INBOUND_POLL_LOOKBACK_MINUTES * 60_000;
    let handledReplies = 0;
    const processedConversationKeys = new Set<string>();
    const processedInboundMessageIds = new Set<string>();

    for (const session of sessions) {
      const locationId = session.locationId?.trim();
      if (!locationId) continue;
      let config: GhlConfig;
      try {
        config = getGhlConfig(locationId);
      } catch {
        continue;
      }
      const channel = session.channel === "EMAIL" ? "EMAIL" : "SMS";
      const contactId = await resolveWorkflowLeadContactId({
        config,
        explicitContactId: session.ghlContactId ?? undefined,
        phone: session.leadPhone ?? undefined,
        email: session.leadEmail ?? undefined,
        name: session.leadName ?? undefined,
        preferredChannel: channel,
      });
      if (!contactId) continue;

      const conversationId = await selectConversationForContact({
        config,
        contactId,
        channel,
        explicitConversationId: session.ghlConversationId ?? undefined,
      });
      if (!conversationId) continue;
      const conversationKey = `${locationId}:${channel}:${conversationId}`;
      if (processedConversationKeys.has(conversationKey)) continue;
      processedConversationKeys.add(conversationKey);

      const page = await listMessages(config, conversationId, 50).catch(() => null);
      if (!page) continue;
      const inboundMessages = page.messages
        .filter((message) => directionLooksInbound(message.direction))
        .filter((message) => messageTypeMatchesChannel(message.type, channel))
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      if (inboundMessages.length === 0) continue;

      const sessionLastInboundMs = Date.parse(session.lastInboundAt ?? "");
      const activatedAtMs = Date.parse(session.activatedAt ?? "");
      const minMs = Number.isFinite(sessionLastInboundMs)
        ? sessionLastInboundMs
        : baselineMs;
      const minAllowedMs = Number.isFinite(activatedAtMs)
        ? Math.max(minMs, activatedAtMs - 15_000)
        : minMs;
      const pendingInbound = inboundMessages.filter((message) => {
        if (processedInboundMessageIds.has(message.id)) return false;
        if (session.lastInboundMessageId && message.id === session.lastInboundMessageId) {
          return false;
        }
        const ts = Date.parse(message.timestamp ?? "");
        if (!Number.isFinite(ts)) return true;
        return ts > minAllowedMs;
      });
      if (pendingInbound.length === 0) continue;

      for (const inboundMessage of pendingInbound) {
        processedInboundMessageIds.add(inboundMessage.id);
        const result = await runWorkflowAgentAutoReplyForGhlInbound({
          session,
          config,
          contactId,
          conversationId,
          inboundMessage: {
            id: inboundMessage.id,
            body: String(inboundMessage.body ?? ""),
            timestamp: inboundMessage.timestamp,
            type: inboundMessage.type,
          },
          channel,
        });
        if (result.handled) handledReplies += 1;
      }
    }

    if (handledReplies > 0) {
      console.log(`GHL inbound poll verwerkt: ${handledReplies} agent auto-replies verzonden.`);
    }
  } catch (error) {
    const message = formatUnknownError(error);
    console.error("GHL inbound poll fout:", message);
  } finally {
    ghlAgentInboundPollBusy = false;
  }
};

const startGhlAgentInboundPolling = () => {
  if (!GHL_AGENT_INBOUND_POLL_ENABLED) return;
  setTimeout(() => {
    void pollGhlAgentInboundMessages();
  }, 5_000);
  setInterval(() => {
    void pollGhlAgentInboundMessages();
  }, GHL_AGENT_INBOUND_POLL_INTERVAL_MS);
};

let workflowAgentFollowUpPollBusy = false;
const pollWorkflowAgentFollowUps = async () => {
  if (workflowAgentFollowUpPollBusy) return;
  workflowAgentFollowUpPollBusy = true;
  try {
    const nowIso = new Date().toISOString();
    const dueSessions = await listWorkflowAgentSessionsDueForFollowUp({
      dueBefore: nowIso,
      limit: WORKFLOW_AGENT_FOLLOWUP_SESSIONS_LIMIT,
    });
    if (dueSessions.length === 0) return;

    let followUpsSent = 0;

    for (const session of dueSessions) {
      const channel = session.channel === "EMAIL" ? "EMAIL" : "SMS";
      const logEvent = async (
        eventType: string,
        level: "info" | "warn" | "error",
        message: string,
        payload?: Record<string, unknown>
      ) => {
        await recordWorkflowAgentEvent({
          workflowId: session.workflowId,
          sessionId: session.id,
          enrollmentId: session.enrollmentId ?? undefined,
          eventType,
          level,
          message,
          payload,
        }).catch(() => undefined);
      };

      try {
        const agent = await getAgent(session.agentId);
        if (!agent || !agent.active) {
          await updateWorkflowAgentSessionFollowUpState(session.id, {
            nextFollowUpAt: null,
          }).catch(() => undefined);
          await logEvent(
            "auto_follow_up_skipped",
            "warn",
            "Automatische follow-up overgeslagen: agent is niet actief."
          );
          continue;
        }

        const settings = await getResolvedAgentSettings(session.agentId);
        const followUpPlan = resolveAgentFollowUpPlan(settings);
        const sentCount =
          Number.isFinite(Number(session.followUpStep)) && Number(session.followUpStep) >= 0
            ? Math.floor(Number(session.followUpStep))
            : 0;
        if (!settings || !followUpPlan.enabled || sentCount >= followUpPlan.maxFollowUps) {
          await updateWorkflowAgentSessionFollowUpState(session.id, {
            followUpStep: sentCount,
            nextFollowUpAt: null,
          }).catch(() => undefined);
          continue;
        }

        const lastOutboundMs = Date.parse(session.lastOutboundAt ?? "");
        if (!Number.isFinite(lastOutboundMs)) {
          await updateWorkflowAgentSessionFollowUpState(session.id, {
            nextFollowUpAt: null,
          }).catch(() => undefined);
          await logEvent(
            "auto_follow_up_skipped",
            "warn",
            "Automatische follow-up overgeslagen: geen geldig laatste outbound tijdstip."
          );
          continue;
        }

        const lastInboundMs = Date.parse(session.lastInboundAt ?? "");
        if (Number.isFinite(lastInboundMs) && lastInboundMs >= lastOutboundMs) {
          await updateWorkflowAgentSessionFollowUpState(session.id, {
            followUpStep: 0,
            nextFollowUpAt: null,
            lastFollowUpAt: null,
          }).catch(() => undefined);
          continue;
        }

        const locationId = session.locationId?.trim();
        if (!locationId) {
          await updateWorkflowAgentSessionFollowUpState(session.id, {
            nextFollowUpAt: null,
          }).catch(() => undefined);
          await logEvent(
            "auto_follow_up_skipped",
            "warn",
            "Automatische follow-up overgeslagen: locationId ontbreekt."
          );
          continue;
        }
        const config = getGhlConfig(locationId);

        const contactId = await resolveWorkflowLeadContactId({
          config,
          explicitContactId: session.ghlContactId ?? undefined,
          phone: session.leadPhone ?? undefined,
          email: session.leadEmail ?? undefined,
          name: session.leadName ?? undefined,
          preferredChannel: channel,
        });
        if (!contactId) {
          await updateWorkflowAgentSessionFollowUpState(session.id, {
            nextFollowUpAt: null,
          }).catch(() => undefined);
          await logEvent(
            "auto_follow_up_skipped",
            "warn",
            "Automatische follow-up overgeslagen: contact niet gevonden."
          );
          continue;
        }

        const conversationId = await selectConversationForContact({
          config,
          contactId,
          channel,
          explicitConversationId: session.ghlConversationId ?? undefined,
        });
        if (!conversationId) {
          await updateWorkflowAgentSessionFollowUpState(session.id, {
            nextFollowUpAt: null,
          }).catch(() => undefined);
          await logEvent(
            "auto_follow_up_skipped",
            "warn",
            "Automatische follow-up overgeslagen: conversatie niet gevonden."
          );
          continue;
        }

        const [messages, contact] = await Promise.all([
          listAllMessages(config, conversationId, 200),
          getContactById(config, contactId).catch(() => null),
        ]);
        const filteredMessages = messages.filter((message) =>
          messageTypeMatchesChannel(message.type, channel)
        );
        const history = filteredMessages.length > 0 ? filteredMessages : messages;
        const sessionNameParts = splitNameParts(session.leadName);
        const suggestion = await suggestReply({
          contact: {
            id: contactId,
            firstName: contact?.firstName ?? sessionNameParts.firstName ?? "Lead",
            lastName: contact?.lastName ?? sessionNameParts.lastName ?? undefined,
            email: contact?.email ?? session.leadEmail ?? undefined,
            phone: contact?.phone ?? session.leadPhone ?? undefined,
            source: "workflow-agent-followup",
            dateAdded: session.activatedAt,
          },
          conversation: {
            id: conversationId,
            channel,
            source: "workflow-agent-followup",
            dateAdded: session.activatedAt,
            dateUpdated: nowIso,
          },
          messages: history,
          maxMessages: 200,
          agent: settings as any,
        });

        const replyText = suggestion.text?.trim();
        if (!replyText) {
          await updateWorkflowAgentSessionFollowUpState(session.id, {
            nextFollowUpAt: null,
          }).catch(() => undefined);
          await logEvent(
            "auto_follow_up_skipped",
            "warn",
            "Automatische follow-up overgeslagen: lege suggestie."
          );
          continue;
        }

        const sendResult = await sendMessage(config, {
          contactId,
          conversationId,
          channel,
          body: replyText,
          ...(channel === "EMAIL" ? { subject: "Opvolging" } : {}),
          locationId: config.locationId,
        });
        const outboundMessageId = sendResult.messageId ?? sendResult.emailMessageId ?? undefined;
        const outboundAt = new Date().toISOString();
        await touchWorkflowAgentSessionOutbound(session.id, outboundAt, outboundMessageId);
        const nextSentCount = sentCount + 1;
        const nextFollowUpAt = getNextFollowUpAt(outboundAt, followUpPlan, nextSentCount);
        await updateWorkflowAgentSessionFollowUpState(session.id, {
          followUpStep: nextSentCount,
          lastFollowUpAt: outboundAt,
          nextFollowUpAt,
        }).catch(() => undefined);

        await recordAgentRun({
          locationId: config.locationId,
          agentId: session.agentId,
          source: "suggest",
          conversationId,
          contactId,
          channel,
          model: suggestion.cost?.model,
          inputTokens: suggestion.usage?.inputTokens,
          outputTokens: suggestion.usage?.outputTokens,
          totalTokens: suggestion.usage?.totalTokens,
          costEur: suggestion.cost?.eur,
          responseMs: undefined,
          promptVersion: agent.currentVersion,
          followUpLimitReached: (suggestion as any).policy?.followUpLimitReached,
          handoffRequired: (suggestion as any).policy?.handoffRequired,
          handoffReason: (suggestion as any).policy?.handoffReason,
          safetyFlags: (suggestion as any).policy?.safetyFlags,
        }).catch(() => undefined);

        await logEvent("auto_follow_up_sent", "info", "Automatische follow-up verstuurd.", {
          channel,
          contactId,
          conversationId,
          providerMessageId: outboundMessageId ?? null,
          followUpStep: nextSentCount,
          totalPlannedFollowUps: followUpPlan.maxFollowUps,
          nextFollowUpAt,
          scheduleHours: followUpPlan.scheduleHours,
          followUpAutoEnabled: followUpPlan.enabled,
          followUpDelayMinMinutes: followUpPlan.minDelayMinutes,
          followUpDelayMaxMinutes: followUpPlan.maxDelayMinutes,
          bodyPreview: replyText.slice(0, 240),
        });
        followUpsSent += 1;
      } catch (error) {
        const message = formatUnknownError(error);
        await logEvent("auto_follow_up_error", "error", message);
      }
    }

    if (followUpsSent > 0) {
      console.log(`Workflow follow-up poll verwerkt: ${followUpsSent} follow-ups verzonden.`);
    }
  } catch (error) {
    const message = formatUnknownError(error);
    console.error("Workflow follow-up poll fout:", message);
  } finally {
    workflowAgentFollowUpPollBusy = false;
  }
};

const startWorkflowAgentFollowUpPolling = () => {
  if (!WORKFLOW_AGENT_FOLLOWUP_POLL_ENABLED) return;
  setTimeout(() => {
    void pollWorkflowAgentFollowUps();
  }, 7_000);
  setInterval(() => {
    void pollWorkflowAgentFollowUps();
  }, WORKFLOW_AGENT_FOLLOWUP_POLL_INTERVAL_MS);
};

app.post("/api/mailgun/webhook/inbound", mailgunUpload.none(), async (req, res, next) => {
  try {
    const signingKey = process.env.MAILGUN_SIGNING_KEY;
    if (!signingKey) {
      res.status(500).json({ error: "MAILGUN_SIGNING_KEY not configured." });
      return;
    }

    const timestamp = req.body?.timestamp;
    const token = req.body?.token;
    const signature = req.body?.signature;
    if (!timestamp || !token || !signature) {
      res.status(400).json({ error: "Missing Mailgun signature." });
      return;
    }

    const hmac = crypto
      .createHmac("sha256", signingKey)
      .update(`${timestamp}${token}`)
      .digest("hex");
    if (hmac !== signature) {
      res.status(403).json({ error: "Invalid signature." });
      return;
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }

    const record = {
      provider: "mailgun",
      message_id: req.body?.["Message-Id"] ?? null,
      from_email: extractEmail(req.body?.sender ?? req.body?.from) ?? null,
      to_email: extractEmail(req.body?.recipient ?? req.body?.to) ?? null,
      subject: req.body?.subject ?? null,
      body_plain: req.body?.["body-plain"] ?? null,
      body_html: req.body?.["body-html"] ?? null,
      timestamp: req.body?.timestamp ? new Date(Number(req.body.timestamp) * 1000).toISOString() : null,
      raw: req.body ?? null,
    };

    const { error } = await supabase.from("mail_inbound").insert(record);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/twilio/webhook/inbound", async (req, res, next) => {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const signature = req.headers["x-twilio-signature"];
    if (authToken && typeof signature === "string") {
      const forwardedProto = req.headers["x-forwarded-proto"];
      const forwardedHost = req.headers["x-forwarded-host"];
      const protocol =
        typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : req.protocol;
      const host =
        typeof forwardedHost === "string" ? forwardedHost.split(",")[0] : req.get("host");
      const url = `${protocol}://${host}${req.originalUrl}`;

      const isValid = twilio.validateRequest(authToken, signature, url, req.body ?? {});
      if (!isValid) {
        res.status(403).json({ error: "Invalid Twilio signature." });
        return;
      }
    }

    const result = await ingestInboundSmsAndAutoReply({
      provider: "twilio",
      messageId: req.body?.MessageSid ?? null,
      fromPhone: req.body?.From ?? null,
      toPhone: req.body?.To ?? null,
      body: req.body?.Body ?? null,
      timestamp: req.body?.DateSent || req.body?.DateCreated || null,
      raw: req.body ?? null,
    });

    if (!result.autoReply.handled) {
      console.log("Workflow agent auto-reply skipped:", result.autoReply.reason);
    }

    res.json({
      success: true,
      duplicate: result.duplicate,
      autoReply: {
        handled: result.autoReply.handled,
        reason: result.autoReply.reason,
      },
    });
  } catch (error) {
    next(error);
  }
});

let twilioInboundPollBusy = false;
const getTwilioInboundPollTargets = () => {
  const configured = (process.env.TWILIO_INBOUND_POLL_TO_NUMBERS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  const fallback = process.env.TWILIO_FROM_NUMBER?.trim();
  return fallback ? [fallback] : [];
};

const pollTwilioInboundMessages = async () => {
  if (twilioInboundPollBusy) return;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return;
  const targets = getTwilioInboundPollTargets();
  if (targets.length === 0) return;

  twilioInboundPollBusy = true;
  try {
    const client = twilio(accountSid, authToken);
    const dateSentAfter = new Date(Date.now() - TWILIO_INBOUND_POLL_LOOKBACK_MINUTES * 60_000);
    let insertedCount = 0;
    let autoRepliesSent = 0;

    for (const toPhone of targets) {
      const messages = await client.messages.list({
        to: toPhone,
        limit: 100,
        dateSentAfter,
      });
      const inboundMessages = messages
        .filter((item) =>
          String((item as { direction?: string | null }).direction ?? "")
            .toLowerCase()
            .includes("inbound")
        )
        .sort((a, b) => {
          const aTs =
            (a.dateSent ?? a.dateCreated ?? a.dateUpdated)?.getTime?.() ??
            Number.NEGATIVE_INFINITY;
          const bTs =
            (b.dateSent ?? b.dateCreated ?? b.dateUpdated)?.getTime?.() ??
            Number.NEGATIVE_INFINITY;
          return aTs - bTs;
        });

      for (const message of inboundMessages) {
        const timestamp = (message.dateSent ?? message.dateCreated ?? message.dateUpdated)
          ?.toISOString?.();
        const result = await ingestInboundSmsAndAutoReply({
          provider: "twilio",
          messageId: message.sid ?? null,
          fromPhone: message.from ?? null,
          toPhone: message.to ?? null,
          body: message.body ?? null,
          timestamp: timestamp ?? null,
          raw: {
            sid: message.sid ?? null,
            direction: message.direction ?? null,
            from: message.from ?? null,
            to: message.to ?? null,
            status: message.status ?? null,
            dateSent: message.dateSent?.toISOString?.() ?? null,
            dateCreated: message.dateCreated?.toISOString?.() ?? null,
            dateUpdated: message.dateUpdated?.toISOString?.() ?? null,
            errorCode: message.errorCode ?? null,
            errorMessage: message.errorMessage ?? null,
            numMedia: message.numMedia ?? null,
          },
        });
        if (result.inserted) insertedCount += 1;
        if (result.autoReply.handled) autoRepliesSent += 1;
      }
    }

    if (insertedCount > 0) {
      console.log(
        `Twilio inbound poll verwerkt: ${insertedCount} nieuw, ${autoRepliesSent} auto-replies verzonden.`
      );
    }
  } catch (error) {
    const message = formatUnknownError(error);
    console.error("Twilio inbound poll fout:", message);
  } finally {
    twilioInboundPollBusy = false;
  }
};

const startTwilioInboundPolling = () => {
  if (!TWILIO_INBOUND_POLL_ENABLED) return;
  setTimeout(() => {
    void pollTwilioInboundMessages();
  }, 3_000);
  setInterval(() => {
    void pollTwilioInboundMessages();
  }, TWILIO_INBOUND_POLL_INTERVAL_MS);
};

app.post("/api/conversations/messages", async (req, res, next) => {
  const schema = z.object({
    conversationId: z.string().optional(),
    contactId: z.string().optional(),
    channel: z.enum(["SMS", "EMAIL"]),
    body: z.string().min(1),
    subject: z.string().optional(),
    locationId: z.string().optional(),
  });

  try {
    const body = schema.parse(req.body);
    const config = getGhlConfig(body.locationId);
    const result = await sendMessage(config, body);
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

const optionalTrimmedString = (maxLength: number) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length ? trimmed : undefined;
    },
    z.string().max(maxLength).optional()
  );

const optionalStringList = (maxItems: number, maxLength: number) =>
  z.preprocess(
    (value) => {
      if (!Array.isArray(value)) return value;
      return value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, maxItems);
    },
    z.array(z.string().max(maxLength)).max(maxItems).optional()
  );

const agentPayloadSchema = z.object({
  id: optionalTrimmedString(120),
  name: optionalTrimmedString(120),
  description: optionalTrimmedString(1500),
  primaryGoal: optionalTrimmedString(120),
  language: optionalTrimmedString(60),
  active: z.boolean().optional(),
  systemPrompt: optionalTrimmedString(4000),
  firstMessage: optionalTrimmedString(1200),
  toneOfVoice: optionalTrimmedString(240),
  assertiveness: z.number().min(0).max(100).optional(),
  responseSpeed: z.enum(["Instant", "Natural", "Slow"]).optional(),
  maxFollowUps: z.number().int().min(0).max(20).optional(),
  intervalHours: z.number().int().min(0).max(720).optional(),
  followUpScheduleHours: z.array(z.number().int().min(0).max(720)).max(20).optional(),
  followUpAutoEnabled: z.boolean().optional(),
  followUpDelayMinMinutes: z.number().int().min(0).max(43200).optional(),
  followUpDelayMaxMinutes: z.number().int().min(0).max(43200).optional(),
  qualificationCriteria: optionalStringList(25, 160),
  qualificationCriteriaMode: optionalTrimmedString(40),
  handoffEnabled: z.boolean().optional(),
  handoffKeywords: optionalStringList(30, 80),
  autoMarkOutcomes: z.boolean().optional(),
  salesHandoverStage: optionalTrimmedString(120),
  reviewNeededStage: optionalTrimmedString(120),
  lostStage: optionalTrimmedString(120),
  lostDecisionPrompt: optionalTrimmedString(4000),
  lostKeywords: optionalStringList(40, 120),
  complianceBlockedPhrases: optionalStringList(30, 120),
  requireOptInForSms: z.boolean().optional(),
  maxReplyChars: z.number().int().min(120).max(2000).optional(),
  faqs: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(280),
        answer: z.string().trim().min(1).max(1200),
      })
    )
    .max(40)
    .optional(),
  websites: optionalStringList(25, 240),
});

app.post("/api/agents/test", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    agentId: z.string().optional(),
    leadName: z.string().optional(),
    channel: z.enum(["SMS", "EMAIL"]).optional(),
    message: z.string().min(1).optional(),
    context: z.string().optional(),
    history: z
      .array(
        z.object({
          role: z.enum(["lead", "agent"]),
          text: z.string().min(1),
        })
      )
      .optional(),
    agent: agentPayloadSchema.optional(),
  });

  try {
    const body = schema.parse(req.body);
    let resolvedAgent = body.agent ? sanitizeAgentSettings(body.agent as Record<string, unknown>) : undefined;
    let agentRecord = null as Awaited<ReturnType<typeof getAgent>>;
    if (body.agentId) {
      try {
        agentRecord = await getAgent(body.agentId);
        const fromStorage = await getResolvedAgentSettings(body.agentId);
        if (!fromStorage && !resolvedAgent) {
          res.status(404).json({ error: "Agent niet gevonden." });
          return;
        }
        if (fromStorage) {
          resolvedAgent = fromStorage;
        }
      } catch {
        if (!resolvedAgent) {
          throw new Error(
            "Agent kon niet worden geladen uit storage. Controleer Supabase of stuur agent payload mee."
          );
        }
      }
    }
    const now = Date.now();
    const type = body.channel === "EMAIL" ? "TYPE_EMAIL" : "TYPE_SMS";
    const hasHistory = Array.isArray(body.history) && body.history.length > 0;
    const hasMessage = !!body.message?.trim();

    if (!hasHistory && !hasMessage) {
      res
        .status(400)
        .json({ error: "Geef een bericht mee of stuur chat history voor de test." });
      return;
    }

    const messages = hasHistory
      ? body.history!.map((item, index) => ({
          id: `test-history-${index}-${now}`,
          conversationId: "test-conversation",
          contactId: "test-contact",
          type,
          direction: item.role === "lead" ? "inbound" : "outbound",
          body: item.text.trim(),
          timestamp: new Date(now - (body.history!.length - index - 1) * 30_000).toISOString(),
        }))
      : [
          ...(body.context?.trim()
            ? [
                {
                  id: `test-out-${now - 1}`,
                  conversationId: "test-conversation",
                  contactId: "test-contact",
                  type,
                  direction: "outbound",
                  body: body.context.trim(),
                  timestamp: new Date(now - 60_000).toISOString(),
                },
              ]
            : []),
          {
            id: `test-in-${now}`,
            conversationId: "test-conversation",
            contactId: "test-contact",
            type,
            direction: "inbound",
            body: body.message!.trim(),
            timestamp: new Date(now).toISOString(),
          },
        ];

    const hasInbound = messages.some((message) =>
      message.direction.toLowerCase().includes("inbound")
    );
    if (!hasInbound) {
      res.status(400).json({ error: "Chat history moet minstens 1 lead-bericht bevatten." });
      return;
    }

    const startedAt = Date.now();
    const testNameParts = splitNameParts(body.leadName ?? "Test lead");
    const suggestion = await suggestReply({
      contact: {
        id: "test-contact",
        firstName: testNameParts.firstName ?? "Test",
        lastName: testNameParts.lastName ?? "lead",
        source: "agent-test",
        dateAdded: new Date(now).toISOString(),
      },
      conversation: {
        id: "test-conversation",
        channel: body.channel,
        source: "agent-test",
        dateAdded: new Date(now - 120_000).toISOString(),
        dateUpdated: new Date(now).toISOString(),
      },
      messages,
      maxMessages: messages.length,
      agent: resolvedAgent as any,
    });
    const elapsed = Date.now() - startedAt;

    let resolvedLocationId = agentRecord?.locationId ?? "test";
    if (body.locationId) {
      try {
        resolvedLocationId = getGhlConfig(body.locationId).locationId;
      } catch {
        resolvedLocationId = agentRecord?.locationId ?? "test";
      }
    }
    await recordAgentRun({
      locationId: resolvedLocationId,
      agentId: body.agentId ?? undefined,
      source: "test",
      conversationId: "test-conversation",
      contactId: "test-contact",
      channel: body.channel,
      model: suggestion.cost?.model,
      inputTokens: suggestion.usage?.inputTokens,
      outputTokens: suggestion.usage?.outputTokens,
      totalTokens: suggestion.usage?.totalTokens,
      costEur: suggestion.cost?.eur,
      responseMs: elapsed,
      promptVersion: agentRecord?.currentVersion,
      followUpLimitReached: (suggestion as any).policy?.followUpLimitReached,
      handoffRequired: (suggestion as any).policy?.handoffRequired,
      handoffReason: (suggestion as any).policy?.handoffReason,
      safetyFlags: (suggestion as any).policy?.safetyFlags,
    }).catch(() => undefined);

    res.json({ suggestion });
  } catch (error) {
    next(error);
  }
});

app.post("/api/suggest", async (req, res, next) => {
  const schema = z.object({
    conversationId: z.string(),
    contactId: z.string(),
    locationId: z.string().optional(),
    agentId: z.string().optional(),
    agent: agentPayloadSchema.optional(),
  });

  try {
    const body = schema.parse(req.body);
    const config = getGhlConfig(body.locationId);
    let resolvedAgent = body.agent
      ? sanitizeAgentSettings(body.agent as Record<string, unknown>)
      : undefined;
    let agentRecord = null as Awaited<ReturnType<typeof getAgent>>;
    if (body.agentId) {
      try {
        agentRecord = await getAgent(body.agentId);
        const fromStorage = await getResolvedAgentSettings(body.agentId);
        if (!fromStorage && !resolvedAgent) {
          res.status(404).json({ error: "Agent niet gevonden." });
          return;
        }
        if (fromStorage) {
          resolvedAgent = fromStorage;
        }
      } catch {
        if (!resolvedAgent) {
          throw new Error(
            "Agent kon niet worden geladen uit storage. Controleer Supabase of stuur agent payload mee."
          );
        }
      }
    }

    const [contact, conversation, messages] = await Promise.all([
      getContactById(config, body.contactId),
      getConversationById(config, body.conversationId),
      listAllMessages(config, body.conversationId, 200),
    ]);

    const startedAt = Date.now();
    const suggestion = await suggestReply({
      contact,
      conversation,
      messages,
      maxMessages: 200,
      agent: resolvedAgent as any,
    });
    const elapsed = Date.now() - startedAt;
    const lastInboundText =
      [...messages]
        .reverse()
        .find((message) => String(message.direction ?? "").toLowerCase().includes("inbound"))
        ?.body ?? "";

    await recordAgentRun({
      locationId: config.locationId,
      agentId: body.agentId ?? undefined,
      source: "suggest",
      conversationId: body.conversationId,
      contactId: body.contactId,
      channel: conversation.channel,
      model: suggestion.cost?.model,
      inputTokens: suggestion.usage?.inputTokens,
      outputTokens: suggestion.usage?.outputTokens,
      totalTokens: suggestion.usage?.totalTokens,
      costEur: suggestion.cost?.eur,
      responseMs: elapsed,
      promptVersion: agentRecord?.currentVersion,
      followUpLimitReached: (suggestion as any).policy?.followUpLimitReached,
      handoffRequired: (suggestion as any).policy?.handoffRequired,
      handoffReason: (suggestion as any).policy?.handoffReason,
      safetyFlags: (suggestion as any).policy?.safetyFlags,
    }).catch(() => undefined);
    const stageUpdate = await maybeMarkOpportunityStageFromAgentOutcome({
      config,
      contactId: body.contactId,
      policy: (suggestion as { policy?: AgentPolicyMeta })?.policy,
      lastInboundText,
      messages,
      agentSettings: (resolvedAgent as Record<string, unknown> | undefined) ?? undefined,
    }).catch(() => ({ marked: false as const, reason: "stage_update_failed" as const }));

    res.json({ suggestion, stageUpdate });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof GhlError) {
    res.status(error.status ?? 500).json({ error: error.userMessage });
    return;
  }

  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Ongeldige invoer.", details: error.errors });
    return;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message)
      : "Unknown error";
  res.status(500).json({ error: message });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

if (process.env.SYNC_ENABLED === "true") {
  startBackgroundSync();
}

startTwilioInboundPolling();
startGhlAgentInboundPolling();
startWorkflowAgentFollowUpPolling();
