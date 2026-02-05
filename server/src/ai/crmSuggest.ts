import OpenAI from "openai";
import { Message } from "../shared/types.js";

export type CrmLeadInfo = {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  status?: string;
  owner?: string;
  createdAt?: string;
  source?: string;
  pipelineStage?: string;
};

export type AutoReplyRule = {
  id: string;
  name: string;
  prompt: string;
  channel: "email" | "sms" | "both";
  enabled: boolean;
  delayMinutes?: number;
  businessHoursOnly?: boolean;
};

const getLastInboundMessage = (messages: Message[]) => {
  const inbound = [...messages].reverse().find((msg) =>
    msg.direction?.toLowerCase().includes("inbound")
  );
  return inbound?.body?.trim();
};

const buildMockSuggestion = (messages: Message[], lead?: CrmLeadInfo) => {
  const lastInbound = getLastInboundMessage(messages);
  const name = lead?.name ? ` ${lead.name}` : "";
  if (!lastInbound) {
    return `Bedankt${name} voor je bericht. Kan je iets meer details delen zodat ik je beter kan helpen?`;
  }

  const snippet =
    lastInbound.length > 120 ? `${lastInbound.slice(0, 120).trim()}...` : lastInbound;
  return `Dank je wel${name} voor je bericht over "${snippet}". Kan je iets meer context geven zodat ik je gericht kan helpen?`;
};

const buildPrompt = (messages: Message[]) => {
  return messages
    .map((msg) => {
      const time = msg.timestamp ? new Date(msg.timestamp).toISOString() : "";
      const subject = msg.subject ? ` | subject: ${msg.subject}` : "";
      return `${time} | ${msg.direction}${subject}: ${msg.body ?? ""}`;
    })
    .join("\n");
};

export const suggestCrmReply = async ({
  lead,
  messages,
  rules,
  channel,
}: {
  lead: CrmLeadInfo;
  messages: Message[];
  rules?: AutoReplyRule[];
  channel?: "email" | "sms";
}) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { text: buildMockSuggestion(messages, lead) };
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
    "Je bent een assistent voor klantcommunicatie. Schrijf vriendelijk en professioneel. Het ALLERBELANGRIJKSTE: antwoord direct op het LAATSTE inbound bericht van de klant en ga in op de concrete inhoud (noem expliciet de genoemde zaken). Gebruik andere context enkel ter ondersteuning. Stel verduidelijkende vragen waar nodig, maar niet generiek als de klant al specifieke info gaf. Verzinnen geen feiten. Doe geen prijs- of juridische toezeggingen. Als de prospect een concreet tijdstip voorstelt, bevestig dat tijdstip en stel geen nieuwe timingvraag.";

  const lastInbound = getLastInboundMessage(messages);
  const leadBlock = JSON.stringify(lead, null, 2);
  const messagesBlock = buildPrompt(messages);

  const rulesBlock =
    rules && rules.length
      ? rules
          .map(
            (rule) =>
              `- ${rule.name} (kanaal: ${rule.channel}, delay: ${rule.delayMinutes ?? 0}m, kantooruren: ${rule.businessHoursOnly ? "ja" : "nee"}): ${rule.prompt}`
          )
          .join("\n")
      : "Geen extra regels.";

  const userPrompt = `Lead info:
${leadBlock}

Kanaal: ${channel ?? "email"}

Auto-reply regels (altijd respecteren):
${rulesBlock}

LAATSTE INBOUND BERICHT (hier moet je primair op antwoorden):
${
    lastInbound ?? "Onbekend"
  }

Berichten (chronologisch):
${messagesBlock}

Schrijf een Nederlandse conceptreactie. Geef alleen de reply tekst.`;

  try {
    const response = await client.responses.create({
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
    });

    const text = response.output_text?.trim();
    if (!text) {
      return { text: buildMockSuggestion(messages, lead) };
    }

    const usage = response.usage;
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;
    const effectiveInput =
      inputTokens == 0 && outputTokens == 0 && totalTokens > 0
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
    };
  } catch {
    return { text: buildMockSuggestion(messages, lead) };
  }
};
