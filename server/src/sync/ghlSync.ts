import { getSupabaseClient } from "../supabase/client.js";
import { hashValue, redactText } from "../supabase/utils.js";
import { getAccountEntries, getGhlConfigForAccount } from "../ghl/accounts.js";
import {
  getConversationById,
  listAllMessages,
  listConversations,
  listConversationsPaged,
  listMessages,
} from "../ghl/conversations.js";
import { getContactById } from "../ghl/contacts.js";
import { suggestReply } from "../ai/suggest.js";
import { classifyLostDraft } from "../ai/lostDraft.js";

const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_SEC ?? "120") * 1000;
const MAX_CONVERSATIONS = Number(process.env.SYNC_MAX_CONVERSATIONS ?? "50");
const MAX_PAGES = Number(process.env.SYNC_MAX_PAGES ?? "10");
const MESSAGE_LIMIT = Number(process.env.SYNC_MESSAGE_LIMIT ?? "50");
const MAX_MESSAGES = Number(process.env.SYNC_MAX_MESSAGES ?? "200");
const shouldCreateDraftsOnBackfill = () =>
  process.env.SYNC_CREATE_DRAFTS_ON_BACKFILL === "true";
const shouldCreateLostDraftsOnBackfill = () =>
  process.env.LOST_DRAFTS_ON_BACKFILL === "true";
const LOST_DRAFTS_ENABLED = process.env.LOST_DRAFTS_ENABLED === "true";
const LOST_DRAFTS_ACCOUNTS = (process.env.LOST_DRAFTS_ACCOUNTS ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const shouldCreateLostDraftsForAccount = (name: string, locationId: string) => {
  if (!LOST_DRAFTS_ENABLED) return false;
  if (LOST_DRAFTS_ACCOUNTS.length === 0) return true;
  const normalizedName = name.toLowerCase();
  const normalizedId = locationId.toLowerCase();
  return LOST_DRAFTS_ACCOUNTS.some(
    (entry) => entry === normalizedName || entry === normalizedId
  );
};

type SyncStats = {
  accounts: number;
  inboundMessages: number;
  drafts: number;
};

const upsertAccount = async (accountId: string, name: string) => {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await supabase.from("accounts").upsert({ id: accountId, name }, { onConflict: "id" });
};

const getSyncState = async (accountId: string) => {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data } = await supabase
    .from("sync_state")
    .select("last_synced_at")
    .eq("account_id", accountId)
    .maybeSingle();
  return data?.last_synced_at ? new Date(data.last_synced_at).getTime() : null;
};

const setSyncState = async (accountId: string, time: Date) => {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await supabase.from("sync_state").upsert(
    {
      account_id: accountId,
      last_synced_at: time.toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" }
  );
};

const upsertConversation = async (
  accountId: string,
  conversationId: string,
  payload: Record<string, unknown>
) => {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await supabase
    .from("conversations")
    .upsert({ id: conversationId, account_id: accountId, ...payload }, { onConflict: "id" });
};

const upsertMessage = async (
  accountId: string,
  messageId: string,
  payload: Record<string, unknown>
) => {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await supabase
    .from("messages")
    .upsert({ id: messageId, account_id: accountId, ...payload }, { onConflict: "id" });
};

const insertDraft = async (payload: Record<string, unknown>) => {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  const { error } = await supabase
    .from("drafts")
    .upsert(payload, { onConflict: "id" });
  if (error) {
    console.warn("Draft insert failed:", error.message);
    return false;
  }
  return true;
};

const insertLostDraft = async (payload: Record<string, unknown>) => {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  const { error } = await supabase
    .from("lost_drafts")
    .upsert(payload, { onConflict: "id" });
  if (error) {
    console.warn("Lost draft insert failed:", error.message);
    return false;
  }
  return true;
};

const buildDraftSummary = (lastInbound?: string) => {
  if (!lastInbound) return "";
  const text = redactText(lastInbound);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
};

const normalizeText = (value?: string | null) =>
  (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const shouldSkipDraftMessage = (msg: { body?: string | null; subject?: string | null; type?: string | null }) => {
  const body = normalizeText(msg.body);
  const subject = normalizeText(msg.subject);
  const combined = `${body} ${subject}`.trim();

  if (!body || body === "(leeg)" || body === "leeg" || body === "empty") {
    return true;
  }

  const type = normalizeText(msg.type);
  if (type.includes("call") && body.length === 0) {
    return true;
  }

  const skipPhrases = [
    "dnd enabled by customer",
    "do not disturb",
    "do not contact",
    "opted out",
    "unsubscribe",
    "unsubscribed",
    "stop",
    "call attempted",
    "missed call",
    "incoming call",
    "call missed",
  ];

  if (skipPhrases.some((phrase) => combined.includes(phrase))) {
    return true;
  }

  return false;
};

const syncAccount = async (
  locationId: string,
  name: string,
  options?: { full?: boolean; createDrafts?: boolean }
) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("Supabase not configured");
  }

  const config = getGhlConfigForAccount(locationId);
  const accountId = hashValue(locationId);
  await upsertAccount(accountId, name);

  const lastSynced = options?.full ? 0 : await getSyncState(accountId);
  const now = new Date();
  if (!lastSynced && !options?.full) {
    await setSyncState(accountId, now);
    return { inboundMessages: 0, drafts: 0 };
  }

  const conversations = options?.full
    ? await listConversationsPaged(config, {
        pageLimit: MAX_CONVERSATIONS,
        maxPages: MAX_PAGES,
      })
    : await listConversations(config);
  const recent = options?.full ? conversations : conversations.slice(0, MAX_CONVERSATIONS);

  let inboundMessages = 0;
  let drafts = 0;
  const allowLostDrafts = shouldCreateLostDraftsForAccount(name, locationId);

  for (const convo of recent) {
    const convoId = hashValue(convo.id);
    const contactId = convo.contactId ? hashValue(convo.contactId) : undefined;

    await upsertConversation(accountId, convoId, {
      contact_id: contactId,
      last_message_date: convo.lastMessageDate ?? null,
      last_message_body: redactText(convo.lastMessageBody ?? ""),
      updated_at: convo.lastMessageDate ?? null,
      metadata: { product: name },
    });

    const messageList = options?.full
      ? await listAllMessages(config, convo.id, MAX_MESSAGES)
      : (await listMessages(config, convo.id, MESSAGE_LIMIT)).messages;

    const freshMessages = messageList.filter((msg) => {
      const ts = Date.parse(msg.timestamp ?? "");
      return ts > lastSynced;
    });

    const newInbound = freshMessages.filter((msg) =>
      msg.direction?.toLowerCase().includes("in")
    );

    if (freshMessages.length === 0) {
      continue;
    }

    inboundMessages += newInbound.length;

    for (const msg of freshMessages) {
      const msgId = hashValue(msg.id);
      await upsertMessage(accountId, msgId, {
        conversation_id: convoId,
        contact_id: contactId,
        direction: msg.direction,
        type: msg.type,
        body: redactText(msg.body),
        subject: redactText(msg.subject ?? ""),
        timestamp: msg.timestamp,
        metadata: { channel: msg.type, product: name },
      });
    }

    if (newInbound.length === 0) {
      continue;
    }

    if (allowLostDrafts && (!options?.full || shouldCreateLostDraftsOnBackfill())) {
      const latestInbound = newInbound.sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
      )[newInbound.length - 1];
      try {
        const decision = await classifyLostDraft({
          text: latestInbound.body,
          subject: latestInbound.subject,
        });
        if (decision.isLost) {
          const lostId = hashValue(`lost:${convo.id}:${latestInbound.id}`);
          await insertLostDraft({
            id: lostId,
            account_id: accountId,
            conversation_id: convoId,
            message_id: hashValue(latestInbound.id),
            status: "draft",
            reason: decision.reason ?? null,
            confidence: decision.confidence ?? null,
            model: decision.cost?.model ?? null,
            tokens: decision.usage?.totalTokens ?? null,
            cost_eur: decision.cost?.eur ?? null,
            metadata: { source: decision.source ?? "ai" },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      } catch {
        // ignore lost draft failures to keep sync alive
      }
    }

    const eligibleInbound = newInbound.filter((msg) => !shouldSkipDraftMessage(msg));
    if (eligibleInbound.length === 0) {
      continue;
    }

    const allowDrafts =
      options?.createDrafts ?? shouldCreateDraftsOnBackfill();
    if (options?.full && !allowDrafts) {
      continue;
    }

    // Generate draft for the latest inbound in this conversation
    const latestInbound = eligibleInbound.sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
    )[eligibleInbound.length - 1];

    try {
      let contact;
      let conversation;

      try {
        contact = convo.contactId
          ? await getContactById(config, convo.contactId)
          : undefined;
      } catch {
        contact = undefined;
      }

      try {
        conversation = await getConversationById(config, convo.id);
      } catch {
        conversation = undefined;
      }

      const filteredMessages = messageList.filter((msg) => {
        if (!msg.direction?.toLowerCase().includes("in")) {
          return true;
        }
        return !shouldSkipDraftMessage(msg);
      });

      const suggestion = await suggestReply({
        contact,
        conversation,
        messages: filteredMessages,
        maxMessages: 200,
      });

      const draftId = hashValue(`${convo.id}:${latestInbound.id}`);
      const inserted = await insertDraft({
        id: draftId,
        account_id: accountId,
        conversation_id: convoId,
        message_id: hashValue(latestInbound.id),
        prompt_summary: buildDraftSummary(latestInbound.body),
        ai_reply: redactText(suggestion.text),
        model: suggestion.cost?.model ?? null,
        tokens: suggestion.usage?.totalTokens ?? null,
        cost_eur: suggestion.cost?.eur ?? null,
        status: "draft",
      });
      if (inserted) {
        drafts += 1;
      }
    } catch {
      // ignore draft failures to keep sync alive
    }
  }

  await setSyncState(accountId, now);
  return { inboundMessages, drafts };
};

export const syncNow = async (locationId?: string): Promise<SyncStats> => {
  const accounts = getAccountEntries();
  const targets = locationId
    ? accounts.filter((acc) => acc.id === locationId || acc.name === locationId)
    : accounts;
  let inboundMessages = 0;
  let drafts = 0;

  for (const account of targets) {
    const result = await syncAccount(account.id, account.name);
    inboundMessages += result.inboundMessages;
    drafts += result.drafts;
  }

  return { accounts: targets.length, inboundMessages, drafts };
};

export const syncNowWithOptions = async (
  locationId?: string,
  options?: { full?: boolean; createDrafts?: boolean }
): Promise<SyncStats> => {
  const accounts = getAccountEntries();
  const targets = locationId
    ? accounts.filter((acc) => acc.id === locationId || acc.name === locationId)
    : accounts;
  let inboundMessages = 0;
  let drafts = 0;

  for (const account of targets) {
    const result = await syncAccount(account.id, account.name, options);
    inboundMessages += result.inboundMessages;
    drafts += result.drafts;
  }

  return { accounts: targets.length, inboundMessages, drafts };
};

let timer: NodeJS.Timeout | null = null;

export const startBackgroundSync = () => {
  if (timer) return;
  const run = async () => {
    try {
      await syncNow();
    } catch {
      // ignore
    }
  };

  run();
  timer = setInterval(run, SYNC_INTERVAL_MS);
};
