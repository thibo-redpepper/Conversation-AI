import axios from "axios";
import crypto from "crypto";
import { getSupabaseClient } from "../supabase/client.js";

export type AgentStatus = "draft" | "published" | "inactive" | "archived";

export type AgentPayload = {
  id: string;
  locationId: string;
  name: string;
  description?: string;
  status: AgentStatus;
  active: boolean;
  currentVersion: number;
  publishedVersion: number;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  settings: Record<string, unknown>;
};

export type AgentVersion = {
  id: string;
  agentId: string;
  locationId: string;
  version: number;
  settings: Record<string, unknown>;
  changeNote?: string;
  createdAt: string;
};

export type AgentKnowledgeEntry = {
  id: string;
  agentId: string;
  locationId: string;
  sourceType: "faq" | "website" | "note" | "file";
  title?: string;
  sourceUrl?: string;
  content: string;
  contentHash?: string;
  refreshIntervalHours: number;
  lastRefreshedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type AgentRow = {
  id: string;
  location_id: string;
  name: string;
  description: string | null;
  status: AgentStatus;
  active: boolean;
  settings: Record<string, unknown> | null;
  current_version: number;
  published_version: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

type AgentVersionRow = {
  id: string;
  agent_id: string;
  location_id: string;
  version: number;
  settings: Record<string, unknown>;
  change_note: string | null;
  created_at: string;
};

type AgentKnowledgeRow = {
  id: string;
  agent_id: string;
  location_id: string;
  source_type: "faq" | "website" | "note" | "file";
  title: string | null;
  source_url: string | null;
  content: string;
  content_hash: string | null;
  refresh_interval_hours: number;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
};

const toAgentPayload = (row: AgentRow): AgentPayload => ({
  id: row.id,
  locationId: row.location_id,
  name: row.name,
  description: row.description ?? undefined,
  status: row.status,
  active: row.active,
  currentVersion: row.current_version,
  publishedVersion: row.published_version,
  publishedAt: row.published_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  settings: row.settings ?? {},
});

const toAgentVersion = (row: AgentVersionRow): AgentVersion => ({
  id: row.id,
  agentId: row.agent_id,
  locationId: row.location_id,
  version: row.version,
  settings: row.settings ?? {},
  changeNote: row.change_note ?? undefined,
  createdAt: row.created_at,
});

const toKnowledgeEntry = (row: AgentKnowledgeRow): AgentKnowledgeEntry => ({
  id: row.id,
  agentId: row.agent_id,
  locationId: row.location_id,
  sourceType: row.source_type,
  title: row.title ?? undefined,
  sourceUrl: row.source_url ?? undefined,
  content: row.content,
  contentHash: row.content_hash ?? undefined,
  refreshIntervalHours: row.refresh_interval_hours,
  lastRefreshedAt: row.last_refreshed_at ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapRepoError = (error: unknown) => {
  if (
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const message = String((error as { message: string }).message);
    if (
      message.includes('relation "public.ai_agents" does not exist') ||
      message.includes('relation "ai_agents" does not exist')
    ) {
      return new Error(
        "AI Agent storage is niet geïnitialiseerd. Run `server/supabase/ai_agents.sql` in Supabase SQL editor."
      );
    }
  }
  return error;
};

const ensureClient = () => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("Supabase not configured.");
  }
  return supabase;
};

const cleanString = (value: unknown, max = 4000) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
};

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
};

const normalizeFollowUpSchedule = (value: unknown) => {
  if (Array.isArray(value)) {
    const parsed = value
      .map((item) => clampInt(item, 0, 720, NaN))
      .filter((item) => Number.isFinite(item))
      .slice(0, 20);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [] as number[];
};

const resolveFollowUpDelayRangeMinutes = (input: {
  scheduleHours: number[];
  fallbackIntervalHours: number;
  rawMinMinutes: unknown;
  rawMaxMinutes: unknown;
}) => {
  const scheduleMinMinutes =
    input.scheduleHours.length > 0
      ? Math.round(Math.min(...input.scheduleHours) * 60)
      : Math.round(input.fallbackIntervalHours * 60);
  const scheduleMaxMinutes =
    input.scheduleHours.length > 0
      ? Math.round(Math.max(...input.scheduleHours) * 60)
      : Math.round(input.fallbackIntervalHours * 60);
  const minMinutes = clampInt(
    input.rawMinMinutes,
    0,
    30 * 24 * 60,
    scheduleMinMinutes
  );
  const maxMinutes = clampInt(
    input.rawMaxMinutes,
    minMinutes,
    30 * 24 * 60,
    scheduleMaxMinutes
  );
  return { minMinutes, maxMinutes };
};

const DEFAULT_LOST_KEYWORDS = [
  "geen interesse",
  "niet geïnteresseerd",
  "niet geinteresseerd",
  "stop",
  "laat maar",
  "doe maar niet",
  "annuleren",
  "niet meer contacteren",
];

export const sanitizeAgentSettings = (raw?: Record<string, unknown>) => {
  const settings = raw ?? {};
  const unique = (items: unknown, maxItems: number, maxLen: number) => {
    if (!Array.isArray(items)) return [] as string[];
    const dedup = new Set<string>();
    for (const item of items) {
      const cleaned = cleanString(item, maxLen);
      if (!cleaned) continue;
      dedup.add(cleaned);
      if (dedup.size >= maxItems) break;
    }
    return [...dedup];
  };

  const faqs =
    Array.isArray(settings["faqs"]) ?
      (settings["faqs"] as unknown[])
        .map((item) => ({
          question: cleanString((item as { question?: unknown })?.question, 280),
          answer: cleanString((item as { answer?: unknown })?.answer, 1200),
        }))
        .filter((item) => item.question && item.answer)
        .slice(0, 40)
        .map((item) => ({ question: item.question!, answer: item.answer! }))
    : [];

  const responseSpeed = cleanString(settings["responseSpeed"], 20);
  const validResponseSpeed =
    responseSpeed === "Instant" || responseSpeed === "Slow" || responseSpeed === "Natural"
      ? responseSpeed
      : "Natural";
  const fallbackMaxFollowUps = clampInt(settings["maxFollowUps"], 0, 20, 3);
  const fallbackIntervalHours = clampInt(settings["intervalHours"], 0, 720, 24);
  const followUpScheduleHours = normalizeFollowUpSchedule(settings["followUpScheduleHours"]);
  const maxFollowUps =
    followUpScheduleHours.length > 0 ? followUpScheduleHours.length : fallbackMaxFollowUps;
  const intervalHours =
    followUpScheduleHours.length > 0 ? followUpScheduleHours[0] ?? fallbackIntervalHours : fallbackIntervalHours;
  const followUpAutoEnabled =
    typeof settings["followUpAutoEnabled"] === "boolean"
      ? Boolean(settings["followUpAutoEnabled"])
      : true;
  const followUpDelayRange = resolveFollowUpDelayRangeMinutes({
    scheduleHours: followUpScheduleHours,
    fallbackIntervalHours,
    rawMinMinutes: settings["followUpDelayMinMinutes"],
    rawMaxMinutes: settings["followUpDelayMaxMinutes"],
  });

  return {
    ...settings,
    name: cleanString(settings["name"], 120),
    description: cleanString(settings["description"], 1500),
    primaryGoal: cleanString(settings["primaryGoal"], 120),
    language: cleanString(settings["language"], 60) ?? "Nederlands",
    systemPrompt: cleanString(settings["systemPrompt"], 4000),
    firstMessage: cleanString(settings["firstMessage"], 1200),
    toneOfVoice: cleanString(settings["toneOfVoice"], 240) ?? "Professioneel maar vriendelijk",
    assertiveness: clampInt(settings["assertiveness"], 0, 100, 60),
    responseSpeed: validResponseSpeed,
    maxFollowUps,
    intervalHours,
    followUpScheduleHours,
    followUpAutoEnabled,
    followUpDelayMinMinutes: followUpDelayRange.minMinutes,
    followUpDelayMaxMinutes: followUpDelayRange.maxMinutes,
    qualificationCriteria: unique(settings["qualificationCriteria"], 25, 160),
    handoffEnabled:
      typeof settings["handoffEnabled"] === "boolean" ? settings["handoffEnabled"] : true,
    handoffKeywords: unique(settings["handoffKeywords"], 30, 80),
    autoMarkOutcomes:
      typeof settings["autoMarkOutcomes"] === "boolean" ? settings["autoMarkOutcomes"] : true,
    salesHandoverStage:
      cleanString(settings["salesHandoverStage"], 120) ?? "Sales Overdracht",
    reviewNeededStage: cleanString(settings["reviewNeededStage"], 120) ?? "Review Nodig",
    lostStage: cleanString(settings["lostStage"], 120) ?? "Lost",
    lostDecisionPrompt: cleanString(settings["lostDecisionPrompt"], 4000),
    lostKeywords: (() => {
      const value = unique(settings["lostKeywords"], 40, 120);
      return value.length > 0 ? value : [...DEFAULT_LOST_KEYWORDS];
    })(),
    complianceBlockedPhrases: unique(settings["complianceBlockedPhrases"], 30, 120),
    requireOptInForSms:
      typeof settings["requireOptInForSms"] === "boolean"
        ? settings["requireOptInForSms"]
        : true,
    maxReplyChars: clampInt(settings["maxReplyChars"], 120, 2000, 700),
    qualificationCriteriaMode: cleanString(settings["qualificationCriteriaMode"], 40) ?? "assist",
    faqs,
    websites: unique(settings["websites"], 25, 240),
  } as Record<string, unknown>;
};

const deriveKnowledgeFromSettings = (settings: Record<string, unknown>) => {
  const entries: Array<{
    source_type: "faq" | "website";
    title: string | null;
    source_url: string | null;
    content: string;
    content_hash: string;
    refresh_interval_hours: number;
  }> = [];

  const faqs = Array.isArray(settings["faqs"]) ? settings["faqs"] : [];
  for (const raw of faqs) {
    const question = cleanString((raw as { question?: unknown })?.question, 280);
    const answer = cleanString((raw as { answer?: unknown })?.answer, 1200);
    if (!question || !answer) continue;
    const content = `Q: ${question}\nA: ${answer}`;
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    entries.push({
      source_type: "faq",
      title: question,
      source_url: null,
      content,
      content_hash: contentHash,
      refresh_interval_hours: 168,
    });
  }

  const websites = Array.isArray(settings["websites"]) ? settings["websites"] : [];
  for (const raw of websites) {
    const url = cleanString(raw, 240);
    if (!url) continue;
    const content = `Bron website: ${url}`;
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    entries.push({
      source_type: "website",
      title: url,
      source_url: url,
      content,
      content_hash: contentHash,
      refresh_interval_hours: 72,
    });
  }
  return entries;
};

const syncDerivedKnowledge = async (
  agentId: string,
  locationId: string,
  settings: Record<string, unknown>
) => {
  const supabase = ensureClient();
  const derived = deriveKnowledgeFromSettings(settings);
  await supabase
    .from("ai_agent_knowledge")
    .delete()
    .eq("agent_id", agentId)
    .in("source_type", ["faq", "website"]);

  if (!derived.length) return;
  const now = new Date().toISOString();
  await supabase.from("ai_agent_knowledge").insert(
    derived.map((entry) => ({
      agent_id: agentId,
      location_id: locationId,
      ...entry,
      last_refreshed_at: now,
      created_at: now,
      updated_at: now,
    }))
  );
};

export const listAgents = async (locationId: string) => {
  const supabase = ensureClient();
  try {
    const { data, error } = await supabase
      .from("ai_agents")
      .select(
        "id, location_id, name, description, status, active, settings, current_version, published_version, published_at, created_at, updated_at"
      )
      .eq("location_id", locationId)
      .neq("status", "archived")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => toAgentPayload(row as AgentRow));
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const getAgent = async (agentId: string) => {
  const supabase = ensureClient();
  try {
    const { data, error } = await supabase
      .from("ai_agents")
      .select(
        "id, location_id, name, description, status, active, settings, current_version, published_version, published_at, created_at, updated_at"
      )
      .eq("id", agentId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return toAgentPayload(data as AgentRow);
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const getResolvedAgentSettings = async (agentId: string) => {
  const agent = await getAgent(agentId);
  if (!agent) return null;
  const settings = sanitizeAgentSettings(agent.settings);
  return {
    ...settings,
    id: agent.id,
    name: agent.name,
    description: agent.description,
    active: agent.active,
  } as Record<string, unknown>;
};

export const createAgent = async (input: {
  locationId: string;
  name: string;
  description?: string;
  active?: boolean;
  settings?: Record<string, unknown>;
  changeNote?: string;
}) => {
  const supabase = ensureClient();
  try {
    const now = new Date().toISOString();
    const settings = sanitizeAgentSettings(input.settings);
    const name = cleanString(input.name, 120) ?? "Nieuwe agent";
    const description = cleanString(input.description, 1500) ?? cleanString(settings["description"], 1500);
    const active = typeof input.active === "boolean" ? input.active : true;
    const { data, error } = await supabase
      .from("ai_agents")
      .insert({
        location_id: input.locationId,
        name,
        description: description ?? null,
        status: "draft",
        active,
        settings,
        current_version: 1,
        published_version: 0,
        created_at: now,
        updated_at: now,
      })
      .select(
        "id, location_id, name, description, status, active, settings, current_version, published_version, published_at, created_at, updated_at"
      )
      .single();
    if (error) throw error;

    const row = data as AgentRow;
    await supabase.from("ai_agent_versions").insert({
      agent_id: row.id,
      location_id: row.location_id,
      version: 1,
      settings,
      change_note: cleanString(input.changeNote, 500) ?? "Initial version",
      created_at: now,
    });

    await syncDerivedKnowledge(row.id, row.location_id, settings);
    return toAgentPayload(row);
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const updateAgent = async (
  agentId: string,
  input: {
    name?: string;
    description?: string;
    active?: boolean;
    settings?: Record<string, unknown>;
    changeNote?: string;
  }
) => {
  const supabase = ensureClient();
  try {
    const current = await getAgent(agentId);
    if (!current) return null;

    const nextVersion = current.currentVersion + 1;
    const now = new Date().toISOString();
    const mergedSettings = sanitizeAgentSettings({
      ...current.settings,
      ...(input.settings ?? {}),
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      active: typeof input.active === "boolean" ? input.active : current.active,
    });
    const name = cleanString(input.name, 120) ?? current.name;
    const description =
      cleanString(input.description, 1500) ??
      cleanString(mergedSettings["description"], 1500) ??
      current.description;
    const active = typeof input.active === "boolean" ? input.active : current.active;

    const { data, error } = await supabase
      .from("ai_agents")
      .update({
        name,
        description: description ?? null,
        active,
        settings: mergedSettings,
        status: current.status === "archived" ? "archived" : "draft",
        current_version: nextVersion,
        updated_at: now,
      })
      .eq("id", agentId)
      .select(
        "id, location_id, name, description, status, active, settings, current_version, published_version, published_at, created_at, updated_at"
      )
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    await supabase.from("ai_agent_versions").insert({
      agent_id: agentId,
      location_id: current.locationId,
      version: nextVersion,
      settings: mergedSettings,
      change_note: cleanString(input.changeNote, 500) ?? "Update",
      created_at: now,
    });

    await syncDerivedKnowledge(agentId, current.locationId, mergedSettings);
    return toAgentPayload(data as AgentRow);
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const publishAgent = async (agentId: string, note?: string) => {
  const supabase = ensureClient();
  try {
    const current = await getAgent(agentId);
    if (!current) return null;
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("ai_agents")
      .update({
        status: "published",
        published_version: current.currentVersion,
        published_at: now,
        updated_at: now,
      })
      .eq("id", agentId)
      .select(
        "id, location_id, name, description, status, active, settings, current_version, published_version, published_at, created_at, updated_at"
      )
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (note) {
      await supabase.from("ai_agent_versions").update({
        change_note: cleanString(note, 500),
      }).eq("agent_id", agentId).eq("version", current.currentVersion);
    }
    return toAgentPayload(data as AgentRow);
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const rollbackAgent = async (
  agentId: string,
  version: number,
  options?: { publish?: boolean; note?: string }
) => {
  const supabase = ensureClient();
  try {
    const current = await getAgent(agentId);
    if (!current) return null;

    const { data: versionRow, error: versionError } = await supabase
      .from("ai_agent_versions")
      .select("id, agent_id, location_id, version, settings, change_note, created_at")
      .eq("agent_id", agentId)
      .eq("version", version)
      .maybeSingle();
    if (versionError) throw versionError;
    if (!versionRow) return null;

    const settings = sanitizeAgentSettings((versionRow as AgentVersionRow).settings);
    const nextVersion = current.currentVersion + 1;
    const now = new Date().toISOString();
    const publish = options?.publish ?? true;

    const { data, error } = await supabase
      .from("ai_agents")
      .update({
        settings,
        status: publish ? "published" : "draft",
        current_version: nextVersion,
        published_version: publish ? nextVersion : current.publishedVersion,
        published_at: publish ? now : current.publishedAt ?? null,
        updated_at: now,
      })
      .eq("id", agentId)
      .select(
        "id, location_id, name, description, status, active, settings, current_version, published_version, published_at, created_at, updated_at"
      )
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    await supabase.from("ai_agent_versions").insert({
      agent_id: agentId,
      location_id: current.locationId,
      version: nextVersion,
      settings,
      change_note: cleanString(options?.note, 500) ?? `Rollback naar v${version}`,
      created_at: now,
    });

    await syncDerivedKnowledge(agentId, current.locationId, settings);
    return toAgentPayload(data as AgentRow);
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const archiveAgent = async (agentId: string) => {
  const supabase = ensureClient();
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("ai_agents")
      .update({ status: "archived", active: false, updated_at: now })
      .eq("id", agentId);
    if (error) throw error;
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const listAgentVersions = async (agentId: string) => {
  const supabase = ensureClient();
  try {
    const { data, error } = await supabase
      .from("ai_agent_versions")
      .select("id, agent_id, location_id, version, settings, change_note, created_at")
      .eq("agent_id", agentId)
      .order("version", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => toAgentVersion(row as AgentVersionRow));
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const listKnowledge = async (agentId: string) => {
  const supabase = ensureClient();
  try {
    const { data, error } = await supabase
      .from("ai_agent_knowledge")
      .select(
        "id, agent_id, location_id, source_type, title, source_url, content, content_hash, refresh_interval_hours, last_refreshed_at, created_at, updated_at"
      )
      .eq("agent_id", agentId)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => toKnowledgeEntry(row as AgentKnowledgeRow));
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const upsertKnowledgeNote = async (input: {
  id?: string;
  agentId: string;
  locationId: string;
  title?: string;
  content: string;
  sourceType?: "note" | "file";
}) => {
  const supabase = ensureClient();
  try {
    const now = new Date().toISOString();
    const sourceType = input.sourceType ?? "note";
    const payload = {
      id: input.id,
      agent_id: input.agentId,
      location_id: input.locationId,
      source_type: sourceType,
      title: cleanString(input.title, 240) ?? null,
      source_url: null,
      content: cleanString(input.content, 12000) ?? "",
      content_hash: crypto.createHash("sha256").update(input.content).digest("hex"),
      refresh_interval_hours: 720,
      last_refreshed_at: now,
      updated_at: now,
    };

    const query = supabase
      .from("ai_agent_knowledge")
      .upsert(
        {
          ...payload,
          created_at: now,
        },
        { onConflict: "id" }
      )
      .select(
        "id, agent_id, location_id, source_type, title, source_url, content, content_hash, refresh_interval_hours, last_refreshed_at, created_at, updated_at"
      )
      .single();
    const { data, error } = await query;
    if (error) throw error;
    return toKnowledgeEntry(data as AgentKnowledgeRow);
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const deleteKnowledgeEntry = async (knowledgeId: string) => {
  const supabase = ensureClient();
  try {
    const { error } = await supabase.from("ai_agent_knowledge").delete().eq("id", knowledgeId);
    if (error) throw error;
  } catch (error) {
    throw mapRepoError(error);
  }
};

const stripHtml = (value: string) =>
  value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export const refreshWebsiteKnowledgeEntry = async (knowledgeId: string) => {
  const supabase = ensureClient();
  try {
    const { data, error } = await supabase
      .from("ai_agent_knowledge")
      .select(
        "id, agent_id, location_id, source_type, title, source_url, content, content_hash, refresh_interval_hours, last_refreshed_at, created_at, updated_at"
      )
      .eq("id", knowledgeId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const entry = data as AgentKnowledgeRow;
    if (entry.source_type !== "website" || !entry.source_url) {
      return toKnowledgeEntry(entry);
    }

    const response = await axios.get(entry.source_url, {
      timeout: 12_000,
      headers: {
        "User-Agent": "LeadAI-KnowledgeSync/1.0",
      },
      responseType: "text",
    });
    const rawText = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const normalized = stripHtml(rawText).slice(0, 20_000);
    const hash = crypto.createHash("sha256").update(normalized).digest("hex");
    const now = new Date().toISOString();

    const { data: updated, error: updateError } = await supabase
      .from("ai_agent_knowledge")
      .update({
        content: normalized || `Bron website: ${entry.source_url}`,
        content_hash: hash,
        last_refreshed_at: now,
        updated_at: now,
        title: cleanString(entry.title, 240) ?? cleanString(entry.source_url, 240) ?? null,
      })
      .eq("id", knowledgeId)
      .select(
        "id, agent_id, location_id, source_type, title, source_url, content, content_hash, refresh_interval_hours, last_refreshed_at, created_at, updated_at"
      )
      .single();
    if (updateError) throw updateError;
    return toKnowledgeEntry(updated as AgentKnowledgeRow);
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const refreshAgentWebsiteKnowledge = async (agentId: string) => {
  const items = await listKnowledge(agentId);
  const websites = items.filter((item) => item.sourceType === "website" && item.sourceUrl);
  const refreshed: AgentKnowledgeEntry[] = [];
  for (const website of websites) {
    const updated = await refreshWebsiteKnowledgeEntry(website.id);
    if (updated) refreshed.push(updated);
  }
  return refreshed;
};

export const recordAgentRun = async (input: {
  locationId: string;
  agentId?: string;
  source: "suggest" | "test";
  conversationId?: string;
  contactId?: string;
  channel?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costEur?: number;
  responseMs?: number;
  promptVersion?: number;
  followUpLimitReached?: boolean;
  handoffRequired?: boolean;
  handoffReason?: string;
  safetyFlags?: string[];
}) => {
  const supabase = ensureClient();
  try {
    await supabase.from("ai_agent_runs").insert({
      location_id: input.locationId,
      agent_id: input.agentId ?? null,
      source: input.source,
      conversation_id: input.conversationId ?? null,
      contact_id: input.contactId ?? null,
      channel: input.channel ?? null,
      model: input.model ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      total_tokens: input.totalTokens ?? null,
      cost_eur: input.costEur ?? null,
      response_ms: input.responseMs ?? null,
      prompt_version: input.promptVersion ?? null,
      follow_up_limit_reached: Boolean(input.followUpLimitReached),
      handoff_required: Boolean(input.handoffRequired),
      handoff_reason: input.handoffReason ?? null,
      safety_flags: input.safetyFlags ?? [],
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const getAgentStats = async (locationId: string, days = 30) => {
  const supabase = ensureClient();
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("ai_agent_runs")
      .select(
        "agent_id, source, cost_eur, response_ms, handoff_required, follow_up_limit_reached, model, created_at"
      )
      .eq("location_id", locationId)
      .gte("created_at", since);
    if (error) throw error;

    const rows = (data ?? []) as Array<{
      agent_id: string | null;
      source: "suggest" | "test";
      cost_eur: number | null;
      response_ms: number | null;
      handoff_required: boolean;
      follow_up_limit_reached: boolean;
      model: string | null;
      created_at: string;
    }>;

    const aggregate = (items: typeof rows) => {
      const count = items.length;
      const totalCost = items.reduce((sum, row) => sum + (Number(row.cost_eur) || 0), 0);
      const avgCost = count ? totalCost / count : 0;
      const latencies = items.map((row) => Number(row.response_ms) || 0).filter((value) => value > 0);
      const avgLatencyMs = latencies.length
        ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
        : 0;
      const handoffCount = items.filter((row) => row.handoff_required).length;
      const followUpStops = items.filter((row) => row.follow_up_limit_reached).length;
      const bySource = items.reduce<Record<string, number>>((acc, row) => {
        acc[row.source] = (acc[row.source] ?? 0) + 1;
        return acc;
      }, {});
      return {
        count,
        avgCostEur: Number(avgCost.toFixed(6)),
        avgLatencyMs: Math.round(avgLatencyMs),
        handoffCount,
        handoffRate: count ? Number((handoffCount / count).toFixed(4)) : 0,
        followUpStops,
        bySource,
      };
    };

    const byAgent: Record<string, ReturnType<typeof aggregate>> = {};
    const grouped = new Map<string, typeof rows>();
    rows.forEach((row) => {
      const key = row.agent_id ?? "unassigned";
      const current = grouped.get(key) ?? [];
      current.push(row);
      grouped.set(key, current);
    });
    grouped.forEach((items, key) => {
      byAgent[key] = aggregate(items);
    });

    return {
      overall: aggregate(rows),
      byAgent,
      windowDays: days,
    };
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const listHandoffs = async (locationId: string, limit = 100) => {
  const supabase = ensureClient();
  try {
    const { data, error } = await supabase
      .from("ai_agent_runs")
      .select(
        "id, agent_id, conversation_id, contact_id, source, handoff_reason, safety_flags, created_at"
      )
      .eq("location_id", locationId)
      .eq("handoff_required", true)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const listEvalCases = async (locationId: string) => {
  const supabase = ensureClient();
  try {
    const { data, error } = await supabase
      .from("ai_agent_eval_cases")
      .select("id, location_id, title, payload, expected, active, created_at, updated_at")
      .eq("location_id", locationId)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const upsertEvalCase = async (input: {
  id?: string;
  locationId: string;
  title: string;
  payload: Record<string, unknown>;
  expected: Record<string, unknown>;
  active?: boolean;
}) => {
  const supabase = ensureClient();
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("ai_agent_eval_cases")
      .upsert(
        {
          id: input.id,
          location_id: input.locationId,
          title: cleanString(input.title, 240) ?? "Unnamed case",
          payload: input.payload,
          expected: input.expected,
          active: typeof input.active === "boolean" ? input.active : true,
          updated_at: now,
          created_at: now,
        },
        { onConflict: "id" }
      )
      .select("id, location_id, title, payload, expected, active, created_at, updated_at")
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const deleteEvalCase = async (id: string) => {
  const supabase = ensureClient();
  try {
    const { error } = await supabase.from("ai_agent_eval_cases").delete().eq("id", id);
    if (error) throw error;
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const recordEvalRun = async (input: {
  locationId: string;
  agentId?: string;
  caseId?: string;
  passed: boolean;
  score: number;
  feedback?: string;
  output?: string;
}) => {
  const supabase = ensureClient();
  try {
    await supabase.from("ai_agent_eval_runs").insert({
      location_id: input.locationId,
      agent_id: input.agentId ?? null,
      case_id: input.caseId ?? null,
      passed: input.passed,
      score: input.score,
      feedback: cleanString(input.feedback, 2000) ?? null,
      output: cleanString(input.output, 8000) ?? null,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    throw mapRepoError(error);
  }
};

export const listEvalRuns = async (locationId: string, limit = 100) => {
  const supabase = ensureClient();
  try {
    const { data, error } = await supabase
      .from("ai_agent_eval_runs")
      .select("id, location_id, agent_id, case_id, passed, score, feedback, output, created_at")
      .eq("location_id", locationId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  } catch (error) {
    throw mapRepoError(error);
  }
};
