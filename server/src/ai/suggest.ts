import OpenAI from "openai";
import { Message } from "../shared/types.js";
import { ContactDetails } from "../ghl/contacts.js";
import { ConversationDetails } from "../ghl/conversations.js";

type AgentInput = SuggestContext["agent"];
type ResponseSpeed = "Instant" | "Natural" | "Slow";

type NormalizedAgentProfile = {
  id?: string;
  name?: string;
  description?: string;
  primaryGoal?: string;
  language: string;
  active?: boolean;
  systemPrompt?: string;
  firstMessage?: string;
  toneOfVoice?: string;
  assertiveness: number;
  responseSpeed: ResponseSpeed;
  maxFollowUps: number;
  intervalHours: number;
  followUpScheduleHours: number[];
  followUpAutoEnabled: boolean;
  followUpDelayMinMinutes: number;
  followUpDelayMaxMinutes: number;
  qualificationCriteria: string[];
  qualificationCriteriaMode: string;
  handoffEnabled: boolean;
  handoffKeywords: string[];
  complianceBlockedPhrases: string[];
  requireOptInForSms: boolean;
  maxReplyChars: number;
  faqs: { question: string; answer: string }[];
  websites: string[];
};

type AgentPolicy = {
  promptBlock: string;
  followUpLimitReached: boolean;
  responseSpeed: ResponseSpeed;
  maxOutputTokens: number;
  maxReplyChars: number;
  blockedPhrases: string[];
  handoffRequired: boolean;
  handoffReason?: string;
  safetyFlags: string[];
};

const RESPONSE_SPEED_TOKENS: Record<ResponseSpeed, number> = {
  Instant: 120,
  Natural: 220,
  Slow: 320,
};

const RESPONSE_SPEED_SENTENCES: Record<ResponseSpeed, number> = {
  Instant: 2,
  Natural: 4,
  Slow: 6,
};

const DEFAULT_HANDOFF_KEYWORDS = [
  "klacht",
  "boos",
  "advocaat",
  "juridisch",
  "fraude",
  "opzeggen",
  "annuleren",
  "refund",
  "terugbetaling",
];

const stripHtml = (value: string) =>
  value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const cleanString = (value: unknown, max = 4000) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
};

const clampNumber = (value: unknown, min: number, max: number, fallback: number) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
};

const normalizeDirection = (direction?: string) => direction?.toLowerCase() ?? "";
const isInbound = (message: Message) => normalizeDirection(message.direction).includes("inbound");
const isOutbound = (message: Message) => normalizeDirection(message.direction).includes("outbound");

const getLastInboundMessage = (messages: Message[]) => {
  const inbound = [...messages].reverse().find((msg) => isInbound(msg));
  return inbound?.body?.trim();
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

const buildContactTemplateValues = (contact?: ContactDetails) => {
  const firstName = cleanString(contact?.firstName, 120) ?? "daar";
  const lastName = cleanString(contact?.lastName, 120) ?? "";
  const fullName = `${firstName} ${lastName}`.trim() || firstName;
  const email = cleanString(contact?.email, 240) ?? "onbekend";
  const phone = cleanString(contact?.phone, 120) ?? "onbekend";
  const city = cleanString(contact?.city, 120) ?? "onbekend";
  const postalCode = cleanString(contact?.postalCode, 40) ?? "onbekend";
  const source = cleanString(contact?.source, 120) ?? "onbekend";

  return {
    "contact.first_name": firstName,
    "contact.firstname": firstName,
    "contact.last_name": lastName,
    "contact.lastname": lastName,
    "contact.full_name": fullName,
    "contact.fullname": fullName,
    "contact.name": fullName,
    "contact.email": email,
    "contact.phone": phone,
    "contact.city": city,
    "contact.postal_code": postalCode,
    "contact.postalcode": postalCode,
    "contact.source": source,
  } as const;
};

export const renderContactTemplate = (
  template: string | undefined,
  contact?: ContactDetails
) => {
  if (!template) return "";
  const values = buildContactTemplateValues(contact);
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, rawKey: string) => {
    const normalized = rawKey.trim().toLowerCase().replace(/\s+/g, "_");
    return values[normalized as keyof typeof values] ?? match;
  });
};

export const normalizeAgentProfile = (agent?: AgentInput): NormalizedAgentProfile | null => {
  if (!agent) return null;
  const rawSpeed = cleanString(agent.responseSpeed, 20);
  const responseSpeed: ResponseSpeed =
    rawSpeed === "Instant" || rawSpeed === "Slow" || rawSpeed === "Natural"
      ? rawSpeed
      : "Natural";

  const fallbackMaxFollowUps = Math.round(clampNumber(agent.maxFollowUps, 0, 20, 3));
  const fallbackIntervalHours = Math.round(clampNumber(agent.intervalHours, 0, 720, 24));
  const followUpScheduleHours = normalizeFollowUpSchedule(
    (agent as Record<string, unknown>)["followUpScheduleHours"]
  );
  const maxFollowUps =
    followUpScheduleHours.length > 0 ? followUpScheduleHours.length : fallbackMaxFollowUps;
  const intervalHours =
    followUpScheduleHours.length > 0 ? followUpScheduleHours[0] ?? fallbackIntervalHours : fallbackIntervalHours;
  const followUpAutoEnabled =
    typeof (agent as Record<string, unknown>)["followUpAutoEnabled"] === "boolean"
      ? Boolean((agent as Record<string, unknown>)["followUpAutoEnabled"])
      : true;
  const followUpDelayRange = resolveFollowUpDelayRangeMinutes({
    scheduleHours: followUpScheduleHours,
    fallbackIntervalHours,
    rawMinMinutes: (agent as Record<string, unknown>)["followUpDelayMinMinutes"],
    rawMaxMinutes: (agent as Record<string, unknown>)["followUpDelayMaxMinutes"],
  });

  return {
    id: cleanString(agent.id, 120),
    name: cleanString(agent.name, 120),
    description: cleanString(agent.description, 1500),
    primaryGoal: cleanString(agent.primaryGoal, 120),
    language: cleanString(agent.language, 60) ?? "Nederlands",
    active: agent.active,
    systemPrompt: cleanString(agent.systemPrompt, 4000),
    firstMessage: cleanString(agent.firstMessage, 1200),
    toneOfVoice: cleanString(agent.toneOfVoice, 240),
    assertiveness: clampNumber(agent.assertiveness, 0, 100, 60),
    responseSpeed,
    maxFollowUps,
    intervalHours,
    followUpScheduleHours,
    followUpAutoEnabled,
    followUpDelayMinMinutes: followUpDelayRange.minMinutes,
    followUpDelayMaxMinutes: followUpDelayRange.maxMinutes,
    qualificationCriteria: normalizeList(agent.qualificationCriteria, 25, 160),
    qualificationCriteriaMode: cleanString((agent as Record<string, unknown>)["qualificationCriteriaMode"], 40) ?? "assist",
    handoffEnabled:
      typeof (agent as Record<string, unknown>)["handoffEnabled"] === "boolean"
        ? Boolean((agent as Record<string, unknown>)["handoffEnabled"])
        : true,
    handoffKeywords: normalizeList(
      (agent as Record<string, unknown>)["handoffKeywords"],
      30,
      80
    ),
    complianceBlockedPhrases: normalizeList(
      (agent as Record<string, unknown>)["complianceBlockedPhrases"],
      30,
      120
    ),
    requireOptInForSms:
      typeof (agent as Record<string, unknown>)["requireOptInForSms"] === "boolean"
        ? Boolean((agent as Record<string, unknown>)["requireOptInForSms"])
        : true,
    maxReplyChars: Math.round(
      clampNumber((agent as Record<string, unknown>)["maxReplyChars"], 120, 2000, 700)
    ),
    faqs: normalizeFaqs(agent.faqs),
    websites: normalizeList(agent.websites, 25, 240),
  };
};

const inferAssertivenessStyle = (assertiveness: number) => {
  if (assertiveness >= 75) {
    return "Direct en resultaatgericht. Stuur aan op duidelijke volgende stap.";
  }
  if (assertiveness <= 35) {
    return "Rustig en adviserend. Duw niet, hou empathisch tempo.";
  }
  return "Gebalanceerd: professioneel, duidelijk en niet opdringerig.";
};

const getConversationText = (messages: Message[]) =>
  messages
    .map((msg) => stripHtml(msg.body || ""))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");

const findMissingCriteria = (criteria: string[], messages: Message[]) => {
  if (!criteria.length) return [];
  const text = getConversationText(messages);
  return criteria.filter((criterion) => {
    const tokens = criterion
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4);
    if (!tokens.length) return !text.includes(criterion.toLowerCase());
    return !tokens.some((token) => text.includes(token));
  });
};

export const countTrailingOutboundWithoutInbound = (messages: Message[]) => {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isInbound(message)) {
      break;
    }
    if (isOutbound(message)) {
      count += 1;
    }
  }
  return count;
};

const buildAgentPolicy = (
  agent: NormalizedAgentProfile | null,
  messages: Message[],
  context?: SuggestContext
): AgentPolicy | null => {
  if (!agent) return null;

  const safetyFlags: string[] = [];
  const lastInbound = (getLastInboundMessage(messages) ?? "").toLowerCase();
  const channel = context?.conversation?.channel?.toUpperCase();
  const trailingOutbound = countTrailingOutboundWithoutInbound(messages);
  const followUpLimitReached =
    agent.followUpAutoEnabled &&
    messages.length > 0 &&
    isOutbound(messages[messages.length - 1]) &&
    trailingOutbound >= agent.maxFollowUps;
  const missingCriteria = findMissingCriteria(agent.qualificationCriteria, messages);
  const assertivenessStyle = inferAssertivenessStyle(agent.assertiveness);
  const keywordPool = Array.from(
    new Set([...DEFAULT_HANDOFF_KEYWORDS, ...agent.handoffKeywords.map((keyword) => keyword.toLowerCase())])
  );
  const matchedHandoffKeyword = keywordPool.find((keyword) => keyword && lastInbound.includes(keyword));
  const hasOptOutSignal =
    channel === "SMS" &&
    /(stop|unsubscribe|afmelden|geen\s+berichten|niet\s+meer\s+contacteren)/i.test(lastInbound);
  if (hasOptOutSignal) safetyFlags.push("sms_opt_out_detected");
  if (matchedHandoffKeyword) safetyFlags.push("handoff_keyword_detected");

  const handoffRequired =
    agent.handoffEnabled && (Boolean(matchedHandoffKeyword) || hasOptOutSignal);
  const handoffReason = hasOptOutSignal
    ? "Lead vraagt om SMS stop/opt-out"
    : matchedHandoffKeyword
    ? `Escalatie keyword: ${matchedHandoffKeyword}`
    : undefined;

  const speedRule =
    agent.responseSpeed === "Instant"
      ? "Kort antwoord: max 2 zinnen, zeer concreet."
      : agent.responseSpeed === "Slow"
      ? "Mag uitgebreider: max 6 zinnen, leg rustig uit."
      : "Natuurlijk ritme: max 4 zinnen.";

  const followUpRule =
    !agent.followUpAutoEnabled
      ? "Automatische follow-ups staan uit."
      : followUpLimitReached
      ? `Follow-up limiet bereikt (${trailingOutbound}/${agent.maxFollowUps}). Schrijf een korte, respectvolle afsluiter zonder vraagteken of nieuwe call-to-action.`
      : `Follow-up limiet: ${agent.maxFollowUps}. Als je een vraag stelt, stel maximaal 1 concrete vraag.`;

  const qualificationRule =
    missingCriteria.length > 0
      ? `Niet-bevestigde kwalificatiecriteria: ${missingCriteria
          .slice(0, 3)
          .join(", ")}. Vraag er hoogstens 1 tegelijk uit.`
      : agent.qualificationCriteria.length > 0
      ? "Kwalificatiecriteria lijken al gekend; herhaal ze niet onnodig."
      : "Geen kwalificatiecriteria opgegeven.";

  const qualificationModeRule =
    agent.qualificationCriteriaMode === "strict"
      ? "Kwalificatie is STRICT: stel prioriteit aan criteria voor je afsluit."
      : "Kwalificatie is ASSIST: help eerst inhoudelijk, kwalificeer subtiel.";
  const hasOutboundMessages = messages.some((message) => isOutbound(message));
  const renderedFirstMessage = renderContactTemplate(agent.firstMessage, context?.contact);

  const promptBlock = [
    "Agent instellingen (HARD, volg strikt):",
    `- Taal: ${agent.language}`,
    `- Primair doel: ${agent.primaryGoal ?? "Geen specifiek doel ingesteld"}`,
    `- Tone of voice: ${agent.toneOfVoice ?? "Professioneel en vriendelijk"}`,
    `- Assertiviteit (${agent.assertiveness}%): ${assertivenessStyle}`,
    `- Response snelheid (${agent.responseSpeed}): ${speedRule}`,
    `- ${followUpRule}`,
    `- Interval tussen follow-ups: ${
      agent.intervalHours <= 0 ? "instant" : `${agent.intervalHours} uur`
    }`,
    `- Follow-up schema (uren): ${
      agent.followUpScheduleHours.length > 0 ? agent.followUpScheduleHours.join(", ") : "geen"
    }`,
    `- Automatische follow-ups: ${agent.followUpAutoEnabled ? "aan" : "uit"}`,
    `- Follow-up wachttijd range: ${agent.followUpDelayMinMinutes} - ${agent.followUpDelayMaxMinutes} minuten`,
    `- Max reply lengte: ${agent.maxReplyChars} tekens`,
    `- SMS opt-in vereist: ${agent.requireOptInForSms ? "ja" : "nee"}`,
    `- ${qualificationRule}`,
    `- ${qualificationModeRule}`,
    handoffRequired
      ? `- Handoff vereist: ja (${handoffReason}). Geef korte menselijke overdrachtstekst.`
      : "- Handoff vereist: nee",
    agent.complianceBlockedPhrases.length
      ? `- Verboden claims/frasen: ${agent.complianceBlockedPhrases.join(", ")}`
      : null,
    agent.systemPrompt ? `- Extra agent instructies: ${agent.systemPrompt}` : null,
    agent.firstMessage
      ? `- Eerste bericht template (met ingevulde placeholders): ${renderedFirstMessage}`
      : null,
    agent.firstMessage && !hasOutboundMessages
      ? "- Dit is het eerste outbound bericht in deze conversatie: gebruik het template als basis."
      : null,
    "Verboden: hallucineren, juridische/prijsbeloftes, generieke copy zonder inhoudelijke aansluiting.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    promptBlock,
    followUpLimitReached,
    responseSpeed: agent.responseSpeed,
    maxOutputTokens: RESPONSE_SPEED_TOKENS[agent.responseSpeed],
    maxReplyChars: agent.maxReplyChars,
    blockedPhrases: agent.complianceBlockedPhrases,
    handoffRequired,
    handoffReason,
    safetyFlags,
  };
};

const buildMockSuggestion = (
  messages: Message[],
  agent: NormalizedAgentProfile | null,
  contact?: ContactDetails
) => {
  const lastInbound = getLastInboundMessage(messages);
  const language = agent?.language?.toLowerCase() ?? "nederlands";
  const isEnglish = language.includes("eng");
  const isFrench = language.includes("fran");

  if (!lastInbound) {
    if (agent?.firstMessage) {
      const renderedTemplate = renderContactTemplate(agent.firstMessage, contact).trim();
      if (renderedTemplate) return renderedTemplate;
    }
    if (isEnglish) {
      return "Thanks for your message. Could you share a bit more detail so I can help you better?";
    }
    if (isFrench) {
      return "Merci pour votre message. Pouvez-vous partager un peu plus de détails pour que je puisse mieux vous aider ?";
    }
    return "Dank je voor je bericht. Kan je wat extra details delen zodat ik je beter kan helpen?";
  }

  const snippet =
    lastInbound.length > 120 ? `${lastInbound.slice(0, 120).trim()}...` : lastInbound;
  if (isEnglish) {
    return `Thanks for your message about "${snippet}". Happy to help further. Could you share what outcome you're aiming for?`;
  }
  if (isFrench) {
    return `Merci pour votre message concernant "${snippet}". Je vous aide avec plaisir. Pouvez-vous préciser votre objectif ?`;
  }
  return `Dank je voor je bericht over "${snippet}". Ik help je graag verder. Kan je kort aangeven wat je precies zoekt?`;
};

const buildPrompt = (messages: Message[]) => {
  const trimmed = messages.map((msg) => {
    const time = msg.timestamp ? new Date(msg.timestamp).toISOString() : "";
    const body = msg.body ? stripHtml(msg.body) : "";
    return `${time} | ${msg.direction} | ${msg.type}: ${body}`;
  });

  return trimmed.join("\n");
};

export type SuggestContext = {
  contact?: ContactDetails;
  conversation?: ConversationDetails;
  messages: Message[];
  maxMessages?: number;
  agent?: {
    id?: string;
    name?: string;
    description?: string;
    primaryGoal?: string;
    language?: string;
    active?: boolean;
    systemPrompt?: string;
    firstMessage?: string;
    toneOfVoice?: string;
    assertiveness?: number;
    responseSpeed?: string;
    maxFollowUps?: number;
    intervalHours?: number;
    followUpScheduleHours?: number[];
    followUpAutoEnabled?: boolean;
    followUpDelayMinMinutes?: number;
    followUpDelayMaxMinutes?: number;
    qualificationCriteria?: string[];
    qualificationCriteriaMode?: string;
    handoffEnabled?: boolean;
    handoffKeywords?: string[];
    complianceBlockedPhrases?: string[];
    requireOptInForSms?: boolean;
    maxReplyChars?: number;
    faqs?: { question: string; answer: string }[];
    websites?: string[];
  };
};

export const suggestReply = async (context: SuggestContext) => {
  const { messages } = context;
  const agent = normalizeAgentProfile(context.agent);
  const policy = buildAgentPolicy(agent, messages, context);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const fallback = applyResponseSpeedLimit(
      buildMockSuggestion(messages, agent, context.contact),
      policy?.responseSpeed ?? "Natural"
    );
    const finalized = finalizeReply(fallback, policy, agent?.language ?? "Nederlands");
    const safetyFlags = [...(policy?.safetyFlags ?? []), ...(finalized.safetyFlags ?? [])];
    return {
      text: finalized.text,
      policy: policy
        ? {
            responseSpeed: policy.responseSpeed,
            followUpLimitReached: policy.followUpLimitReached,
            handoffRequired: policy.handoffRequired || finalized.handoffRequired,
            handoffReason: policy.handoffReason ?? finalized.handoffReason,
            safetyFlags: Array.from(new Set(safetyFlags)),
          }
        : undefined,
    };
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const rawInput = Number(process.env.OPENAI_PRICE_INPUT_PER_1M ?? "0.15");
  const rawOutput = Number(process.env.OPENAI_PRICE_OUTPUT_PER_1M ?? "0.60");
  const rawFx = Number(process.env.USD_TO_EUR_RATE ?? "0.92");
  const priceInputPer1M = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0.15;
  const priceOutputPer1M = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0.60;
  const usdToEur = Number.isFinite(rawFx) && rawFx > 0 ? rawFx : 0.92;

  const client = new OpenAI({ apiKey });

  const baseSystemPrompt =
    "Je bent een assistent voor vastgoedcommunicatie. Je antwoordt exact op het laatste inbound klantbericht en gebruikt oudere context alleen aanvullend. Wees concreet, professioneel en menselijk. Geen hallucinaties, geen juridische of prijsbeloftes. Als klant een concreet tijdstip geeft: bevestig dat tijdstip expliciet.";

  const systemPrompt = policy
    ? `${baseSystemPrompt}\n\n${policy.promptBlock}`
    : baseSystemPrompt;

  const contactBlock = context.contact
    ? JSON.stringify(context.contact, null, 2)
    : "Onbekend";
  const conversationBlock = context.conversation
    ? JSON.stringify(context.conversation, null, 2)
    : "Onbekend";
  const messagesBlock = buildPrompt(messages);
  const lastInbound = getLastInboundMessage(messages);
  const countInfo = `Aantal berichten: ${messages.length}${
    context.maxMessages ? ` (max ${context.maxMessages})` : ""
  }`;
  const keyFacts = [
    `Tijd van aanvraag (contact.dateAdded): ${context.contact?.dateAdded ?? "Onbekend"}`,
    `Contact source: ${context.contact?.source ?? "Onbekend"}`,
    `Attribution source: ${context.contact?.attributionSource ? "Aanwezig" : "Onbekend"}`,
  ].join("\n");

  const knowledgeBlock = agent
    ? [
        agent.faqs.length
          ? `FAQs:\n${agent.faqs
              .map((faq) => `- Q: ${faq.question}\n  A: ${faq.answer}`)
              .join("\n")}`
          : null,
        agent.websites.length
          ? `Websites:\n${agent.websites.map((site) => `- ${site}`).join("\n")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";

  const preferredLanguage = agent?.language ?? "Nederlands";
  const userPrompt = `Belangrijke context:\n${keyFacts}\n${countInfo}\n\nLAATSTE INBOUND BERICHT (hier moet je primair op antwoorden):\n${lastInbound ?? "Onbekend"}\n\nContact:\n${contactBlock}\n\nConversation:\n${conversationBlock}\n\nBerichten (chronologisch, alle beschikbare tot max):\n${messagesBlock}\n\n${knowledgeBlock ? `Kennisbank:\n${knowledgeBlock}\n\n` : ""}Schrijf een conceptreactie in ${preferredLanguage}. Geef alleen de reply tekst en volg alle agent-instellingen strikt.`;

  try {
    const assertiveness = agent?.assertiveness ?? 60;
    const temperature =
      assertiveness >= 80 ? 0.45 : assertiveness <= 30 ? 0.25 : 0.35;

    const response = await client.responses.create({
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature,
      max_output_tokens: policy?.maxOutputTokens,
    });

    const rawText = response.output_text?.trim();
    const finalized = finalizeReply(rawText, policy, agent?.language ?? "Nederlands");
    const text = finalized.text;
    if (!text) {
      const fallback = applyResponseSpeedLimit(
        buildMockSuggestion(messages, agent, context.contact),
        policy?.responseSpeed ?? "Natural"
      );
      const fallbackFinalized = finalizeReply(
        fallback,
        policy,
        agent?.language ?? "Nederlands"
      );
      return {
        text: fallbackFinalized.text,
        policy: withPolicyMetadata(policy, fallbackFinalized),
      };
    }

    const usage = response.usage;
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;
    const effectiveInput =
      inputTokens === 0 && outputTokens === 0 && totalTokens > 0
        ? totalTokens
        : inputTokens;
    const costUsd =
      (effectiveInput * priceInputPer1M) / 1_000_000 +
      (outputTokens * priceOutputPer1M) / 1_000_000;
    const costEur = costUsd * usdToEur;

    return {
      text,
      usage: { inputTokens, outputTokens, totalTokens },
      cost: {
        usd: Number.isFinite(costUsd) ? costUsd : undefined,
        eur: Number.isFinite(costEur) ? costEur : undefined,
        usdToEurRate: usdToEur,
        model,
      },
      policy: withPolicyMetadata(policy, finalized),
    };
  } catch {
    const fallback = applyResponseSpeedLimit(
      buildMockSuggestion(messages, agent, context.contact),
      policy?.responseSpeed ?? "Natural"
    );
    const finalized = finalizeReply(fallback, policy, agent?.language ?? "Nederlands");
    return {
      text: finalized.text,
      policy: withPolicyMetadata(policy, finalized),
    };
  }
};

const applyResponseSpeedLimit = (value: string, responseSpeed: ResponseSpeed) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentenceLimit = RESPONSE_SPEED_SENTENCES[responseSpeed];
  const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= sentenceLimit) return normalized;
  return sentences.slice(0, sentenceLimit).join(" ").trim();
};

const buildHandoffMessage = (language: string, reason?: string) => {
  const lower = language.toLowerCase();
  if (lower.includes("eng")) {
    return `Thanks for your message. I’m handing this over to a colleague for personal follow-up${reason ? ` (${reason})` : ""}.`;
  }
  if (lower.includes("fran")) {
    return `Merci pour votre message. Je transmets ceci à un collègue pour un suivi personnel${reason ? ` (${reason})` : ""}.`;
  }
  return `Dank je voor je bericht. Ik zet dit meteen door naar een collega voor persoonlijke opvolging${reason ? ` (${reason})` : ""}.`;
};

const finalizeReply = (
  value: string | undefined,
  policy: AgentPolicy | null | undefined,
  language: string
) => {
  if (!value) return { text: "", handoffRequired: false, safetyFlags: [] as string[] };
  let normalized = value
    .replace(/^antwoord:\s*/i, "")
    .replace(/^reply:\s*/i, "")
    .trim();

  if (!normalized) return { text: "", handoffRequired: false, safetyFlags: [] as string[] };
  normalized = applyResponseSpeedLimit(normalized, policy?.responseSpeed ?? "Natural");

  const safetyFlags = [...(policy?.safetyFlags ?? [])];
  let handoffRequired = Boolean(policy?.handoffRequired);
  let handoffReason = policy?.handoffReason;

  if (policy?.blockedPhrases?.length) {
    const blockedDetected = policy.blockedPhrases.filter((phrase) =>
      phrase && normalized.toLowerCase().includes(phrase.toLowerCase())
    );
    if (blockedDetected.length > 0) {
      blockedDetected.forEach((phrase) => {
        const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        normalized = normalized.replace(pattern, "");
      });
      safetyFlags.push("blocked_claim_detected");
      handoffRequired = true;
      handoffReason = handoffReason ?? "Blocked claim detected";
    }
  }

  if (policy?.maxReplyChars && normalized.length > policy.maxReplyChars) {
    normalized = `${normalized.slice(0, Math.max(40, policy.maxReplyChars - 1)).trim()}…`;
    safetyFlags.push("reply_truncated");
  }

  if (policy?.followUpLimitReached) {
    normalized = normalized.replace(/\?/g, ".");
    if (!/[.!]$/.test(normalized)) {
      normalized = `${normalized}.`;
    }
  }

  if (handoffRequired) {
    normalized = buildHandoffMessage(language, handoffReason);
  }

  return {
    text: normalized,
    handoffRequired,
    handoffReason,
    safetyFlags: Array.from(new Set(safetyFlags)),
  };
};

const withPolicyMetadata = (
  policy: AgentPolicy | null | undefined,
  finalized: { handoffRequired: boolean; handoffReason?: string; safetyFlags: string[] }
) => {
  if (!policy) return undefined;
  return {
    responseSpeed: policy.responseSpeed,
    followUpLimitReached: policy.followUpLimitReached,
    handoffRequired: policy.handoffRequired || finalized.handoffRequired,
    handoffReason: policy.handoffReason ?? finalized.handoffReason,
    safetyFlags: Array.from(new Set([...(policy.safetyFlags ?? []), ...(finalized.safetyFlags ?? [])])),
  };
};
