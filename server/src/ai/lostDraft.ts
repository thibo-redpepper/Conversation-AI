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

const ruleMatch = (text: string): LostDecision | null => {
  const normalized = normalize(text);
  if (!normalized) return null;
  const hit = RULE_PHRASES.find((phrase) => normalized.includes(phrase));
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
}: {
  text?: string | null;
  subject?: string | null;
}): Promise<LostDecision> => {
  const combined = [subject, text].filter(Boolean).join("\n").trim();
  if (!combined) {
    return { isLost: false };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return ruleMatch(combined) ?? { isLost: false };
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const rawInput = Number(process.env.OPENAI_PRICE_INPUT_PER_1M ?? "0.15");
  const rawOutput = Number(process.env.OPENAI_PRICE_OUTPUT_PER_1M ?? "0.60");
  const rawFx = Number(process.env.USD_TO_EUR_RATE ?? "0.92");
  const priceInputPer1M = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0.15;
  const priceOutputPer1M = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0.60;
  const usdToEur = Number.isFinite(rawFx) && rawFx > 0 ? rawFx : 0.92;

  const client = new OpenAI({ apiKey });
  const systemPrompt =
    "Je bent een classifier voor inbound klantberichten. Bepaal of het bericht aangeeft dat de lead geen interesse heeft, wil stoppen met contact, of expliciet niet meer gebeld/gecontacteerd wil worden. Geef alleen JSON terug met velden: is_lost (boolean), reason (korte uitleg), confidence (0-1).";
  const userPrompt = `Bericht:\n"""${combined}"""\n\nGeef JSON.`;

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
    const confidenceRaw = typeof parsed?.confidence === "number" ? parsed.confidence : undefined;
    const confidence = Number.isFinite(confidenceRaw)
      ? clamp(confidenceRaw)
      : isLost
        ? 0.5
        : undefined;

    if (parsed) {
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

    const fallback = ruleMatch(combined);
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
    return ruleMatch(combined) ?? { isLost: false };
  }
};
