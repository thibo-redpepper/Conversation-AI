import OpenAI from "openai";
import { Message } from "../shared/types.js";
import { ContactDetails } from "../ghl/contacts.js";
import { ConversationDetails } from "../ghl/conversations.js";

const getLastInboundMessage = (messages: Message[]) => {
  const inbound = [...messages].reverse().find((msg) =>
    msg.direction?.toLowerCase().includes("inbound")
  );
  return inbound?.body?.trim();
};

const stripHtml = (value: string) =>
  value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const buildMockSuggestion = (messages: Message[]) => {
  const lastInbound = getLastInboundMessage(messages);
  if (!lastInbound) {
    return "Dank je wel voor je bericht. Kun je iets meer details delen zodat ik je beter kan helpen?";
  }

  const snippet =
    lastInbound.length > 120 ? `${lastInbound.slice(0, 120).trim()}...` : lastInbound;
  return `Dank je wel voor je bericht over \"${snippet}\". Ik help je graag verder. Kun je aangeven wat je precies zoekt en in welke prijsklasse?`;
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
};

export const suggestReply = async (context: SuggestContext) => {
  const { messages } = context;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { text: buildMockSuggestion(messages) };
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
    "Je bent een assistent voor vastgoedcommunicatie. Schrijf vriendelijk en professioneel. Het ALLERBELANGRIJKSTE: antwoord direct op het LAATSTE inbound bericht van de klant en ga in op de concrete inhoud (noem expliciet de genoemde onderdelen). Gebruik andere context enkel ter ondersteuning. Stel verduidelijkende vragen waar nodig, maar niet generiek als de klant al specifieke info gaf. Verzinnen geen feiten. Doe geen prijs- of juridische toezeggingen. Als de prospect een concreet tijdstip voorstelt, bevestig dat tijdstip en stel geen nieuwe timingvraag.";

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

  const userPrompt = `Belangrijke context:\n${keyFacts}\n${countInfo}\n\nLAATSTE INBOUND BERICHT (hier moet je primair op antwoorden):\n${lastInbound ?? "Onbekend"}\n\nContact:\n${contactBlock}\n\nConversation:\n${conversationBlock}\n\nBerichten (chronologisch, alle beschikbare tot max):\n${messagesBlock}\n\nSchrijf een Nederlandse conceptreactie. Geef alleen de reply tekst.`;

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
      return { text: buildMockSuggestion(messages) };
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
    };
  } catch {
    return { text: buildMockSuggestion(messages) };
  }
};
