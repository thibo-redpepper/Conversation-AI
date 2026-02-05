import { getSupabaseClient } from "./client.js";

export const supabaseReady = () => Boolean(getSupabaseClient());

export const upsertAccount = async (name: string) => {
  const client = getSupabaseClient();
  if (!client) return;
  await client.from("accounts").upsert({ name }, { onConflict: "name" });
};

export const upsertConversation = async (data: {
  conversation_hash: string;
  account_name: string;
  contact_hash?: string;
  context?: Record<string, unknown>;
  last_message_at?: string;
  last_message_direction?: string;
  last_message_body?: string;
}) => {
  const client = getSupabaseClient();
  if (!client) return;
  await client.from("conversations").upsert(
    {
      ...data,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "conversation_hash" }
  );
};

export const upsertMessage = async (data: {
  message_hash: string;
  conversation_hash: string;
  account_name: string;
  direction?: string;
  type?: string;
  subject?: string;
  body?: string;
  timestamp?: string;
  raw?: Record<string, unknown>;
}) => {
  const client = getSupabaseClient();
  if (!client) return;
  await client.from("messages").upsert(data, { onConflict: "message_hash" });
};

export const upsertDraft = async (data: {
  message_hash: string;
  conversation_hash: string;
  account_name: string;
  draft_text: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_eur?: number;
}) => {
  const client = getSupabaseClient();
  if (!client) return;
  await client.from("drafts").upsert(data, { onConflict: "message_hash" });
};

export const getSyncState = async (accountName: string) => {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data } = await client
    .from("sync_state")
    .select("last_synced_at")
    .eq("account_name", accountName)
    .maybeSingle();
  return data?.last_synced_at ?? null;
};

export const setSyncState = async (accountName: string, timestamp: string) => {
  const client = getSupabaseClient();
  if (!client) return;
  await client
    .from("sync_state")
    .upsert({ account_name: accountName, last_synced_at: timestamp });
};
