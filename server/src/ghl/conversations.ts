import { z } from "zod";
import { createGhlClient, GhlConfig, mapGhlError } from "./client.js";
import { Conversation, Message } from "../shared/types.js";

const DateValueSchema = z.union([z.string(), z.number()]).optional().nullable();
const NumberValueSchema = z.union([z.number(), z.string()]).optional().nullable();

const ConversationSchema = z.object({
  id: z.string(),
  contactId: z.string().optional().nullable(),
  channel: z.string().optional().nullable(),
  lastMessageDate: DateValueSchema,
  updatedAt: DateValueSchema,
  lastMessageBody: z.string().optional().nullable(),
  lastMessageDirection: z.string().optional().nullable(),
  unreadCount: NumberValueSchema,
});

const ConversationsResponseSchema = z
  .object({
    conversations: z.array(ConversationSchema).optional(),
    data: z.array(ConversationSchema).optional(),
    total: z.number().optional(),
    meta: z.any().optional(),
  })
  .passthrough();

const ConversationDetailsSchema = z
  .object({
    id: z.string(),
    contactId: z.string().optional().nullable(),
    lastMessageDate: DateValueSchema,
    lastMessageBody: z.string().optional().nullable(),
    lastMessageDirection: z.string().optional().nullable(),
    lastMessageType: z.string().optional().nullable(),
    dateAdded: DateValueSchema,
    dateUpdated: DateValueSchema,
    source: z.string().optional().nullable(),
    type: z.string().optional().nullable(),
    channel: z.string().optional().nullable(),
    unreadCount: NumberValueSchema,
  })
  .passthrough();

const MessageSchema = z
  .object({
  id: z.string(),
  body: z.string().optional().nullable(),
  subject: z.string().optional().nullable(),
  direction: z.string().optional().nullable(),
  type: z.union([z.string(), z.number()]).optional().nullable(),
  messageType: z.string().optional().nullable(),
  dateAdded: z.string().optional().nullable(),
  dateUpdated: z.string().optional().nullable(),
  createdAt: z.string().optional().nullable(),
  conversationId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  meta: z
    .object({
      email: z
        .object({
          subject: z.string().optional().nullable(),
          direction: z.string().optional().nullable(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
})
  .passthrough();

const MessagesEnvelopeSchema = z.object({
  messages: z.array(MessageSchema),
  nextPage: z.boolean().optional(),
  lastMessageId: z.string().optional().nullable(),
});

const MessagesResponseSchema = z.object({
  messages: z.union([z.array(MessageSchema), MessagesEnvelopeSchema]).optional(),
  data: z.array(MessageSchema).optional(),
  nextPage: z.boolean().optional(),
  lastMessageId: z.string().optional().nullable(),
});

const toIso = (value?: string | number | null) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString();
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
};

const toNumber = (value?: string | number | null) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

export const listConversations = async (
  config: GhlConfig,
  contactId?: string
) => {
  try {
    const client = createGhlClient(config);
    const response = await client.get("/conversations/search", {
      params: {
        locationId: config.locationId,
        ...(contactId ? { contactId } : {}),
      },
    });

    const parsed = ConversationsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error("Unexpected conversations response format");
    }

    const raw = parsed.data.conversations ?? parsed.data.data ?? [];
    const conversations = raw.map(
      (item): Conversation => ({
        id: item.id,
        contactId: item.contactId ?? undefined,
        channel: item.channel ?? undefined,
        lastMessageDate: toIso(item.lastMessageDate) ?? toIso(item.updatedAt),
        unreadCount: toNumber(item.unreadCount),
        lastMessageBody: item.lastMessageBody ?? undefined,
      })
    );

    conversations.sort((a, b) => {
      const aTime = a.lastMessageDate ? Date.parse(a.lastMessageDate) : 0;
      const bTime = b.lastMessageDate ? Date.parse(b.lastMessageDate) : 0;
      return bTime - aTime;
    });

    return conversations.slice(0, 50);
  } catch (error) {
    throw mapGhlError(error);
  }
};

export const listConversationsPaged = async (
  config: GhlConfig,
  options?: { contactId?: string; pageLimit?: number; maxPages?: number }
) => {
  const client = createGhlClient(config);
  const contactId = options?.contactId;
  const pageLimit = options?.pageLimit ?? 50;
  const maxPages = options?.maxPages ?? 10;
  const seen = new Map<string, Conversation>();
  let noNewPages = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    let response;
    try {
      response = await client.get("/conversations/search", {
        params: {
          locationId: config.locationId,
          ...(contactId ? { contactId } : {}),
          page,
          pageLimit,
        },
      });
    } catch (error) {
      if (page === 1) {
        throw mapGhlError(error);
      }
      break;
    }

    const parsed = ConversationsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      if (page === 1) {
        throw new Error("Unexpected conversations response format");
      }
      break;
    }

    const raw = parsed.data.conversations ?? parsed.data.data ?? [];
    if (raw.length === 0) break;

    let added = 0;
    raw.forEach((item) => {
      if (seen.has(item.id)) return;
      seen.set(item.id, {
        id: item.id,
        contactId: item.contactId ?? undefined,
        channel: item.channel ?? undefined,
        lastMessageDate: toIso(item.lastMessageDate) ?? toIso(item.updatedAt),
        unreadCount: toNumber(item.unreadCount),
        lastMessageBody: item.lastMessageBody ?? undefined,
      });
      added += 1;
    });

    if (added === 0) {
      noNewPages += 1;
      if (noNewPages >= 2) break;
    } else {
      noNewPages = 0;
    }

    if (raw.length < pageLimit) break;
  }

  const conversations = Array.from(seen.values()).sort((a, b) => {
    const aTime = a.lastMessageDate ? Date.parse(a.lastMessageDate) : 0;
    const bTime = b.lastMessageDate ? Date.parse(b.lastMessageDate) : 0;
    return bTime - aTime;
  });

  return conversations;
};

export const filterConversationsWithInbound = async (
  config: GhlConfig,
  conversations: Conversation[],
  max = 50
) => {
  const slice = conversations.slice(0, max);
  const chunkSize = Number(process.env.CONVERSATIONS_INBOUND_CONCURRENCY ?? "8");
  const matched: Conversation[] = [];

  for (let index = 0; index < slice.length; index += chunkSize) {
    const chunk = slice.slice(index, index + chunkSize);
    const checks = await Promise.all(
      chunk.map(async (conversation) => {
        try {
          const page = await listMessages(config, conversation.id, 20);
          const hasInbound = page.messages.some((msg) =>
            msg.direction?.toLowerCase().includes("in")
          );
          return hasInbound ? conversation : null;
        } catch {
          return null;
        }
      })
    );
    matched.push(...checks.filter((item): item is Conversation => Boolean(item)));
  }

  return matched;
};

export type ConversationDetails = {
  id: string;
  contactId?: string;
  lastMessageDate?: string;
  lastMessageBody?: string;
  lastMessageDirection?: string;
  lastMessageType?: string;
  dateAdded?: string;
  dateUpdated?: string;
  source?: string;
  type?: string;
  channel?: string;
  unreadCount?: number;
  raw?: Record<string, unknown>;
};

export const getConversationById = async (
  config: GhlConfig,
  conversationId: string
): Promise<ConversationDetails> => {
  try {
    const client = createGhlClient(config);
    const response = await client.get(`/conversations/${conversationId}`);

    const parsed = ConversationDetailsSchema.safeParse(response.data);
    const data = parsed.success ? parsed.data : response.data;

    return {
      id: data.id,
      contactId: data.contactId ?? undefined,
      lastMessageDate: toIso(data.lastMessageDate),
      lastMessageBody: data.lastMessageBody ?? undefined,
      lastMessageDirection: data.lastMessageDirection ?? undefined,
      lastMessageType: data.lastMessageType ?? undefined,
      dateAdded: toIso(data.dateAdded),
      dateUpdated: toIso(data.dateUpdated),
      source: data.source ?? undefined,
      type: data.type ?? undefined,
      channel: data.channel ?? undefined,
      unreadCount: toNumber(data.unreadCount),
      raw: parsed.success ? undefined : response.data,
    };
  } catch (error) {
    throw mapGhlError(error);
  }
};

export type MessagesPage = {
  messages: Message[];
  nextPage: boolean;
  lastMessageId?: string;
};

export const listMessages = async (
  config: GhlConfig,
  conversationId: string,
  limit = 20,
  lastMessageId?: string
): Promise<MessagesPage> => {
  try {
    const client = createGhlClient(config);
    const response = await client.get(
      `/conversations/${conversationId}/messages`,
      {
        params: {
          limit,
          ...(lastMessageId ? { lastMessageId } : {}),
        },
      }
    );

    const parsed = MessagesResponseSchema.safeParse(response.data);
    const raw = parsed.success ? parsed.data : (response.data as any);

    const envelope = raw?.messages;
    let extractedRaw: unknown = [];
    let nextPage = false;
    let cursor: string | undefined;

    if (Array.isArray(envelope)) {
      extractedRaw = envelope;
      nextPage = raw?.nextPage ?? false;
      cursor = raw?.lastMessageId ?? undefined;
    } else if (envelope && typeof envelope === "object") {
      if (Array.isArray(envelope.messages)) {
        extractedRaw = envelope.messages;
      } else if (Array.isArray(envelope.data)) {
        extractedRaw = envelope.data;
      } else if (Array.isArray(envelope.items)) {
        extractedRaw = envelope.items;
      }
      nextPage = envelope.nextPage ?? raw?.nextPage ?? false;
      cursor = envelope.lastMessageId ?? raw?.lastMessageId ?? undefined;
    } else if (Array.isArray(raw?.data)) {
      extractedRaw = raw.data;
      nextPage = raw?.nextPage ?? false;
      cursor = raw?.lastMessageId ?? undefined;
    }

    const extractedArray = Array.isArray(extractedRaw) ? extractedRaw : [];
    const validated = z.array(MessageSchema).safeParse(extractedArray);
    const extracted = validated.success
      ? validated.data
      : extractedArray
          .map((item) => MessageSchema.safeParse(item))
          .filter((result) => result.success)
          .map((result) => result.data);

    const messages = extracted.map((item): Message => {
      const type =
        item.messageType ??
        (typeof item.type === "string" ? item.type : undefined) ??
        (typeof item.type === "number" ? `TYPE_${item.type}` : undefined) ??
        "UNKNOWN";

      const direction = item.direction ?? item.meta?.email?.direction ?? "UNKNOWN";
      const subject = item.subject ?? item.meta?.email?.subject ?? undefined;

      return {
        id: item.id,
        conversationId: item.conversationId ?? undefined,
        contactId: item.contactId ?? undefined,
        type,
        direction,
        body: item.body ?? "",
        subject,
        timestamp:
          toIso(item.dateAdded) ??
          toIso(item.dateUpdated) ??
          toIso(item.createdAt) ??
          new Date().toISOString(),
      };
    });

    return {
      messages,
      nextPage,
      lastMessageId: cursor,
    };
  } catch (error) {
    throw mapGhlError(error);
  }
};

export const listAllMessages = async (
  config: GhlConfig,
  conversationId: string,
  maxMessages = 200
) => {
  const collected = new Map<string, Message>();
  let lastMessageId: string | undefined;
  let nextPage = true;
  let safety = 0;

  while (nextPage && safety < 20 && collected.size < maxMessages) {
    const page = await listMessages(config, conversationId, 50, lastMessageId);
    page.messages.forEach((msg) => collected.set(msg.id, msg));
    nextPage = page.nextPage;
    lastMessageId = page.lastMessageId;
    safety += 1;

    if (!lastMessageId) {
      break;
    }
  }

  const messages = Array.from(collected.values()).sort((a, b) => {
    const aTime = Date.parse(a.timestamp ?? "") || 0;
    const bTime = Date.parse(b.timestamp ?? "") || 0;
    return aTime - bTime;
  });

  return messages.slice(-maxMessages);
};
