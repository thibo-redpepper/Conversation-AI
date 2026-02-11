import { AiAgent } from "../types";

const STORAGE_KEY = "convo_ai_agents";
const RESPONSE_SPEED_VALUES = ["Instant", "Natural", "Slow"] as const;
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

const createId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `agent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const cleanString = (value: unknown, maxLength: number) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
};

const clampNumber = (value: unknown, min: number, max: number, fallback: number) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
};

const normalizeList = (items: unknown, maxItems: number, maxLength: number) => {
  if (!Array.isArray(items)) return [];
  const unique = new Set<string>();
  for (const item of items) {
    const cleaned = cleanString(item, maxLength);
    if (!cleaned) continue;
    unique.add(cleaned);
    if (unique.size >= maxItems) break;
  }
  return [...unique];
};

const normalizeFaqs = (faqs: unknown): { question: string; answer: string }[] => {
  if (!Array.isArray(faqs)) return [];
  const items: { question: string; answer: string }[] = [];
  for (const raw of faqs) {
    const question = cleanString((raw as { question?: unknown })?.question, 280);
    const answer = cleanString((raw as { answer?: unknown })?.answer, 1200);
    if (!question || !answer) continue;
    items.push({ question, answer });
    if (items.length >= 40) break;
  }
  return items;
};

const normalizeFollowUpSchedule = (schedule: unknown) => {
  if (Array.isArray(schedule)) {
    const parsed = schedule
      .map((item) => Math.round(clampNumber(item, 0, 720, NaN)))
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
  const minMinutes = Math.round(
    clampNumber(input.rawMinMinutes, 0, 30 * 24 * 60, scheduleMinMinutes)
  );
  const maxMinutes = Math.round(
    clampNumber(input.rawMaxMinutes, minMinutes, 30 * 24 * 60, scheduleMaxMinutes)
  );
  return { minMinutes, maxMinutes };
};

export const normalizeAgent = (agent: Partial<AiAgent>): AiAgent => {
  const responseSpeedCandidate = cleanString(agent.responseSpeed, 20);
  const responseSpeed = RESPONSE_SPEED_VALUES.includes(
    responseSpeedCandidate as (typeof RESPONSE_SPEED_VALUES)[number]
  )
    ? (responseSpeedCandidate as (typeof RESPONSE_SPEED_VALUES)[number])
    : "Natural";
  const fallbackMaxFollowUps = Math.round(clampNumber(agent.maxFollowUps, 0, 20, 3));
  const fallbackIntervalHours = Math.round(clampNumber(agent.intervalHours, 0, 720, 24));
  const followUpScheduleHours = normalizeFollowUpSchedule(agent.followUpScheduleHours);
  const maxFollowUps =
    followUpScheduleHours.length > 0 ? followUpScheduleHours.length : fallbackMaxFollowUps;
  const intervalHours =
    followUpScheduleHours.length > 0 ? followUpScheduleHours[0] ?? fallbackIntervalHours : fallbackIntervalHours;
  const followUpAutoEnabled =
    typeof agent.followUpAutoEnabled === "boolean" ? agent.followUpAutoEnabled : true;
  const followUpDelayRange = resolveFollowUpDelayRangeMinutes({
    scheduleHours: followUpScheduleHours,
    fallbackIntervalHours,
    rawMinMinutes: agent.followUpDelayMinMinutes,
    rawMaxMinutes: agent.followUpDelayMaxMinutes,
  });

  return {
    id: cleanString(agent.id, 120) ?? createId(),
    name: cleanString(agent.name, 120) ?? "Nieuwe agent",
    locationId: cleanString(agent.locationId, 120),
    status:
      cleanString(agent.status, 40) === "published" ||
      cleanString(agent.status, 40) === "inactive" ||
      cleanString(agent.status, 40) === "archived" ||
      cleanString(agent.status, 40) === "draft"
        ? (cleanString(agent.status, 40) as "draft" | "published" | "inactive" | "archived")
        : "draft",
    currentVersion: Math.round(clampNumber(agent.currentVersion, 1, 5000, 1)),
    publishedVersion: Math.round(clampNumber(agent.publishedVersion, 0, 5000, 0)),
    publishedAt: cleanString(agent.publishedAt, 80),
    createdAt: cleanString(agent.createdAt, 80),
    updatedAt: cleanString(agent.updatedAt, 80),
    description: cleanString(agent.description, 1500),
    primaryGoal: cleanString(agent.primaryGoal, 120) ?? "Kwalificeren",
    language: cleanString(agent.language, 60) ?? "Nederlands",
    active: typeof agent.active === "boolean" ? agent.active : true,
    systemPrompt: cleanString(agent.systemPrompt, 4000),
    firstMessage: cleanString(agent.firstMessage, 1200),
    toneOfVoice: cleanString(agent.toneOfVoice, 240) ?? "Professioneel maar vriendelijk",
    assertiveness: Math.round(clampNumber(agent.assertiveness, 0, 100, 60)),
    responseSpeed,
    maxFollowUps,
    intervalHours,
    followUpScheduleHours,
    followUpAutoEnabled,
    followUpDelayMinMinutes: followUpDelayRange.minMinutes,
    followUpDelayMaxMinutes: followUpDelayRange.maxMinutes,
    qualificationCriteriaMode:
      cleanString(agent.qualificationCriteriaMode, 40) === "strict" ? "strict" : "assist",
    qualificationCriteria: normalizeList(agent.qualificationCriteria, 25, 160),
    handoffEnabled: typeof agent.handoffEnabled === "boolean" ? agent.handoffEnabled : true,
    handoffKeywords: normalizeList(agent.handoffKeywords, 30, 80),
    autoMarkOutcomes:
      typeof agent.autoMarkOutcomes === "boolean" ? agent.autoMarkOutcomes : true,
    salesHandoverStage:
      cleanString(agent.salesHandoverStage, 120) ?? "Sales Overdracht",
    reviewNeededStage: cleanString(agent.reviewNeededStage, 120) ?? "Review Nodig",
    lostStage: cleanString(agent.lostStage, 120) ?? "Lost",
    lostDecisionPrompt: cleanString(agent.lostDecisionPrompt, 4000),
    lostKeywords: (() => {
      const value = normalizeList(agent.lostKeywords, 40, 120);
      return value.length > 0 ? value : [...DEFAULT_LOST_KEYWORDS];
    })(),
    complianceBlockedPhrases: normalizeList(agent.complianceBlockedPhrases, 30, 120),
    requireOptInForSms:
      typeof agent.requireOptInForSms === "boolean" ? agent.requireOptInForSms : true,
    maxReplyChars: Math.round(clampNumber(agent.maxReplyChars, 120, 2000, 700)),
    faqs: normalizeFaqs(agent.faqs),
    websites: normalizeList(agent.websites, 25, 240),
  };
};

const normalizeAgents = (agents: Partial<AiAgent>[]) => {
  const used = new Set<string>();
  return agents.map((raw) => {
    const normalized = normalizeAgent(raw);
    let id = normalized.id;
    while (used.has(id)) {
      id = createId();
    }
    used.add(id);
    return { ...normalized, id };
  });
};

const defaultAgents: AiAgent[] = [
  {
    id: "sales-qualifier",
    name: "Sales Qualifier",
    description: "Kwalificeert leads op basis van budget, timeline en beslissing.",
    primaryGoal: "Kwalificeren",
    language: "Nederlands",
    active: true,
    assertiveness: 70,
    responseSpeed: "Natural",
    maxFollowUps: 5,
    intervalHours: 24,
    followUpAutoEnabled: true,
    followUpDelayMinMinutes: 24 * 60,
    followUpDelayMaxMinutes: 24 * 60,
    toneOfVoice: "Professioneel maar vriendelijk",
    qualificationCriteria: ["Budget €5.000+", "Eigenaar woning", "Beslissing binnen 3 maanden"],
    systemPrompt:
      "Je kwalificeert leads door te vragen naar budget, timing en beslissingsbevoegdheid. Wees behulpzaam en to-the-point.",
    firstMessage:
      "Hoi! Bedankt voor je interesse. Mag ik vragen of je al een indicatie hebt van je budget en timing?",
  },
  {
    id: "appointment-planner",
    name: "Afspraak Planner",
    description: "Plant afspraken in voor gekwalificeerde leads.",
    primaryGoal: "Afspraken plannen",
    language: "Nederlands",
    active: true,
    assertiveness: 85,
    responseSpeed: "Instant",
    maxFollowUps: 3,
    intervalHours: 12,
    followUpAutoEnabled: true,
    followUpDelayMinMinutes: 12 * 60,
    followUpDelayMaxMinutes: 12 * 60,
    toneOfVoice: "Vlot en duidelijk",
    systemPrompt:
      "Je doel is het plannen van een afspraak. Bevestig tijden en stel concrete opties voor.",
  },
  {
    id: "nurture-bot",
    name: "Nurture Bot",
    description: "Houdt contact met leads die nog niet klaar zijn om te kopen.",
    primaryGoal: "Nurturing",
    language: "Nederlands",
    active: false,
    assertiveness: 30,
    responseSpeed: "Slow",
    maxFollowUps: 10,
    intervalHours: 48,
    followUpAutoEnabled: true,
    followUpDelayMinMinutes: 48 * 60,
    followUpDelayMaxMinutes: 48 * 60,
    toneOfVoice: "Rustig en informatief",
  },
];

export const loadAgents = (): AiAgent[] => {
  const fallback = normalizeAgents(defaultAgents);
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<AiAgent>[];
    if (!Array.isArray(parsed)) return fallback;
    const normalized = normalizeAgents(parsed);
    return normalized.length > 0 ? normalized : fallback;
  } catch {
    return fallback;
  }
};

export const saveAgents = (agents: AiAgent[]) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeAgents(agents)));
};

export const createAgent = (overrides?: Partial<AiAgent>): AiAgent => {
  return normalizeAgent({
    id: createId(),
    name: "Nieuwe agent",
    primaryGoal: "Kwalificeren",
    language: "Nederlands",
    active: true,
    assertiveness: 60,
    responseSpeed: "Natural",
    maxFollowUps: 3,
    intervalHours: 24,
    followUpAutoEnabled: true,
    followUpDelayMinMinutes: 20,
    followUpDelayMaxMinutes: 40,
    qualificationCriteria: [],
    faqs: [],
    websites: [],
    ...overrides,
  });
};
