import OpenAI from "openai";

type LostDecision = {
  isLost: boolean;
  reason?: string;
  confidence?: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  cost?: { usd?: number; eur?: number; usdToEurRate?: number; model?: string };
  source?: "ai" | "rules";
};

const normalize = (value?: string | null) =>
  (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const RULE_PHRASES = [
  "geen interesse",
  "niet geïnteresseerd",
  "niet geinteresseerd",
  "geen behoefte",
  "geen offerte",
  "hoef geen offerte",
  "niet nodig",
  "niet gewenst",
  "nee bedankt",
  "nee dank",
  "stop",
  "afmelden",
  "uitschrijven",
  "niet contacteren",
  "niet meer bellen",
  "bel me niet",
  "niet bellen",
  "al voorzien",
  "heb al iemand",
  "heb al een aannemer",
];

const normalizeKeywordHints = (keywords?: string[] | null) => {
  if (!Array.isArray(keywords)) return RULE_PHRASES;
  const unique = new Set<string>();
  for (const raw of keywords) {
    const normalized = normalize(raw).slice(0, 120);
    if (!normalized) continue;
    unique.add(normalized);
    if (unique.size >= 80) break;
  }
  return unique.size > 0 ? [...unique] : RULE_PHRASES;
};

const PROMPT_STOPWORDS = new Set([
  "de",
  "het",
  "een",
  "en",
  "of",
  "op",
  "als",
  "dan",
  "bij",
  "van",
  "voor",
  "naar",
  "met",
  "dat",
  "dit",
  "die",
  "ze",
  "zij",
  "je",
  "jij",
  "we",
  "wij",
  "ik",
  "te",
  "om",
  "in",
  "uit",
  "aan",
  "markeer",
  "markeren",
  "lead",
  "leads",
  "lost",
]);

const derivePromptKeywordHints = (prompt?: string | null) => {
  const normalized = normalize(prompt);
  if (!normalized) return [] as string[];

  const relevantBlock = normalized.includes(" als ")
    ? normalized.split(" als ").slice(1).join(" ")
    : normalized;
  const tokens = relevantBlock
    .split(/[^a-z0-9à-ÿ]+/i)
    .map((item) => item.trim())
    .filter(Boolean);

  const unique = new Set<string>();
  for (const token of tokens) {
    if (token.length < 4) continue;
    if (PROMPT_STOPWORDS.has(token)) continue;
    unique.add(token);
    if (unique.size >= 20) break;
  }
  return [...unique];
};

const ruleMatch = (text: string, keywordHints?: string[] | null): LostDecision | null => {
  const normalized = normalize(text);
  if (!normalized) return null;
  const hit = normalizeKeywordHints(keywordHints).find((phrase) => normalized.includes(phrase));
  if (!hit) return null;
  return {
    isLost: true,
    reason: `Match op: "${hit}"`,
    confidence: 0.78,
    source: "rules",
  };
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

const parseDecision = (raw: string) => {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  const slice = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const classifyLostDraft = async ({
  text,
  subject,
  conversationContext,
  lostDecisionPrompt,
  keywordHints,
}: {
  text?: string | null;
  subject?: string | null;
  conversationContext?: string | null;
  lostDecisionPrompt?: string | null;
  keywordHints?: string[] | null;
}): Promise<LostDecision> => {
  const combined = [subject, text].filter(Boolean).join("\n").trim();
  const context = [conversationContext, combined].filter(Boolean).join("\n\n").trim();
  if (!combined) {
    return { isLost: false };
  }
  const promptHints = derivePromptKeywordHints(lostDecisionPrompt);
  const mergedHints = Array.from(new Set([...normalizeKeywordHints(keywordHints), ...promptHints]));

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return ruleMatch(context, mergedHints) ?? { isLost: false };
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const rawInput = Number(process.env.OPENAI_PRICE_INPUT_PER_1M ?? "0.15");
  const rawOutput = Number(process.env.OPENAI_PRICE_OUTPUT_PER_1M ?? "0.60");
  const rawFx = Number(process.env.USD_TO_EUR_RATE ?? "0.92");
  const priceInputPer1M = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0.15;
  const priceOutputPer1M = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0.60;
  const usdToEur = Number.isFinite(rawFx) && rawFx > 0 ? rawFx : 0.92;

  const client = new OpenAI({ apiKey });
  const customPrompt =
    typeof lostDecisionPrompt === "string" && lostDecisionPrompt.trim().length > 0
      ? lostDecisionPrompt.trim().slice(0, 4000)
      : "";
  const baseSystemPrompt = customPrompt
    ? "Je bent een classifier voor inbound klantberichten. BELANGRIJK: gebruik de agent-specifieke beoordelingsregels hieronder als hoogste prioriteit. Markeer `is_lost=true` zodra die regels dit aangeven, ook als dat afwijkt van een klassieke lost-definitie. Geef alleen JSON terug met velden: is_lost (boolean), reason (korte uitleg), confidence (0-1)."
    : "Je bent een classifier voor inbound klantberichten. Bepaal of het bericht aangeeft dat de lead verloren is (geen interesse, stopzetting, expliciete afmelding of duidelijk negatief koopintentsignaal). Geef alleen JSON terug met velden: is_lost (boolean), reason (korte uitleg), confidence (0-1).";
  const keywordHintsBlock = mergedHints.join(", ");
  const systemPrompt = customPrompt
    ? `${baseSystemPrompt}\n\nAgent-specifieke beoordelingsregels:\n${customPrompt}`
    : baseSystemPrompt;
  const userPrompt = `Context (laatste deel van gesprek en nieuwste bericht):
"""${context}"""

Keyword-hints (fallback): ${keywordHintsBlock}

Geef alleen JSON.`;

  try {
    const response = await client.responses.create({
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
    });

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

    const parsed = parseDecision(response.output_text ?? "");
    const isLostRaw =
      parsed?.is_lost ?? parsed?.isLost ?? parsed?.lost ?? parsed?.isLostDraft;
    const isLost = typeof isLostRaw === "boolean" ? isLostRaw : false;
    const reason =
      typeof parsed?.reason === "string" ? parsed.reason.trim().slice(0, 200) : undefined;
    const confidenceRaw =
      typeof parsed?.confidence === "number"
        ? parsed.confidence
        : typeof parsed?.confidence_score === "number"
        ? parsed.confidence_score
        : undefined;
    const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? clamp(confidenceRaw)
      : isLost
        ? 0.5
        : undefined;

    if (parsed) {
      const promptRule = promptHints.length > 0 ? ruleMatch(context, promptHints) : null;
      if (promptRule?.isLost) {
        return {
          isLost: true,
          reason: promptRule.reason ?? reason ?? "custom_prompt_rule_match",
          confidence: Math.max(confidence ?? 0.5, 0.8),
          usage: { inputTokens, outputTokens, totalTokens },
          cost: {
            usd: Number.isFinite(costUsd) ? costUsd : undefined,
            eur: Number.isFinite(costEur) ? costEur : undefined,
            usdToEurRate: usdToEur,
            model,
          },
          source: "rules",
        };
      }
      return {
        isLost,
        reason,
        confidence,
        usage: { inputTokens, outputTokens, totalTokens },
        cost: {
          usd: Number.isFinite(costUsd) ? costUsd : undefined,
          eur: Number.isFinite(costEur) ? costEur : undefined,
          usdToEurRate: usdToEur,
          model,
        },
        source: "ai",
      };
    }

    const fallback = ruleMatch(context, mergedHints);
    if (fallback) {
      return {
        ...fallback,
        usage: { inputTokens, outputTokens, totalTokens },
        cost: {
          usd: Number.isFinite(costUsd) ? costUsd : undefined,
          eur: Number.isFinite(costEur) ? costEur : undefined,
          usdToEurRate: usdToEur,
          model,
        },
      };
    }

    return {
      isLost: false,
      usage: { inputTokens, outputTokens, totalTokens },
      cost: {
        usd: Number.isFinite(costUsd) ? costUsd : undefined,
        eur: Number.isFinite(costEur) ? costEur : undefined,
        usdToEurRate: usdToEur,
        model,
      },
      source: "ai",
    };
  } catch {
    return ruleMatch(context, mergedHints) ?? { isLost: false };
  }
};
