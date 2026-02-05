import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { getContactById, searchContacts } from "./ghl/contacts.js";
import {
  filterConversationsWithInbound,
  getConversationById,
  listAllMessages,
  listConversations,
  listMessages,
} from "./ghl/conversations.js";
import { sendMessage } from "./ghl/sendMessage.js";
import { GhlError, GhlConfig } from "./ghl/client.js";
import { suggestReply } from "./ai/suggest.js";
import { suggestCrmReply } from "./ai/crmSuggest.js";
import { getAccountEntries, getGhlConfigForAccount } from "./ghl/accounts.js";
import { startBackgroundSync, syncNow, syncNowWithOptions } from "./sync/ghlSync.js";
import { getSupabaseClient } from "./supabase/client.js";
import axios from "axios";
import crypto from "crypto";
import multer from "multer";
import twilio from "twilio";

const loadEnv = () => {
  const rootEnv = path.resolve(process.cwd(), "..", ".env");
  const localEnv = path.resolve(process.cwd(), ".env");
  const envPath = fs.existsSync(rootEnv) ? rootEnv : localEnv;
  dotenv.config({ path: envPath });
};

loadEnv();


const extractEmail = (value?: string | null) => {
  if (!value) return null;
  const match = value.match(/<([^>]+)>/);
  const email = (match ? match[1] : value).trim();
  return email ? email.toLowerCase() : null;
};

const cleanEmailReply = (value?: string | null) => {
  if (!value) return "";
  let text = value.replace(/\r\n/g, "\n").trim();
  const splitPatterns = [
    /\nOn .+ wrote:\n/i,
    /\n-----Original Message-----\n/i,
    /\nFrom:\s.+\nSent:\s.+\nTo:\s.+\nSubject:\s.+\n/i,
    /\n_{2,}\n/,
  ];
  for (const pattern of splitPatterns) {
    const parts = text.split(pattern);
    if (parts.length > 1) {
      text = parts[0].trim();
    }
  }
  const lines = text
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .map((line) => line.replace(/^\s*On .* wrote:\s*$/i, ""))
    .filter((line) => line.trim().length > 0);
  return lines.join("\n").trim();
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const mailgunUpload = multer();

const getGhlConfig = (locationId?: string): GhlConfig =>
  getGhlConfigForAccount(locationId);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/locations", (_req, res) => {
  const locations = getAccountEntries().map(({ id, name }) => ({ id, name }));
  res.json({ locations });
});

app.post("/api/contacts/search", async (req, res, next) => {
  const schema = z.object({
    query: z.string().min(1),
    searchAfter: z.string().optional(),
    locationId: z.string().optional(),
  });

  try {
    const body = schema.parse(req.body);
    const config = getGhlConfig(body.locationId);
    const result = await searchContacts(config, body.query, body.searchAfter);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/contacts/:contactId/conversations", async (req, res, next) => {
  try {
    const { contactId } = req.params;
    const locationId = req.query.locationId as string | undefined;
    const inboundOnly = req.query.inboundOnly === "true";
    const config = getGhlConfig(locationId);
    const conversations = await listConversations(config, contactId);
    if (inboundOnly) {
      const filtered = await filterConversationsWithInbound(
        config,
        conversations,
        50
      );
      res.json({ conversations: filtered });
      return;
    }
    res.json({ conversations });
  } catch (error) {
    next(error);
  }
});

app.get("/api/conversations/recent", async (req, res, next) => {
  try {
    const locationId = req.query.locationId as string | undefined;
    const inboundOnly = req.query.inboundOnly === "true";
    const config = getGhlConfig(locationId);
    const conversations = await listConversations(config);
    if (inboundOnly) {
      const filtered = await filterConversationsWithInbound(
        config,
        conversations,
        50
      );
      res.json({ conversations: filtered });
      return;
    }
    res.json({ conversations });
  } catch (error) {
    next(error);
  }
});

app.get("/api/conversations/:conversationId/messages", async (req, res, next) => {
  const schema = z.object({
    limit: z.string().optional(),
    lastMessageId: z.string().optional(),
    locationId: z.string().optional(),
  });

  try {
    const { conversationId } = req.params;
    const query = schema.parse(req.query);
    const limit = query.limit ? Number(query.limit) : 20;
    const config = getGhlConfig(query.locationId);
    const page = await listMessages(config, conversationId, limit, query.lastMessageId);
    res.json(page);
  } catch (error) {
    next(error);
  }
});

app.get("/api/contacts/:contactId", async (req, res, next) => {
  try {
    const { contactId } = req.params;
    const locationId = req.query.locationId as string | undefined;
    const config = getGhlConfig(locationId);
    const contact = await getContactById(config, contactId);
    res.json({ contact });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sync", async (req, res, next) => {
  const schema = z.object({
    locationId: z.string().optional(),
    full: z.boolean().optional(),
    createDrafts: z.boolean().optional(),
  });
  try {
    const body = schema.parse(req.body ?? {});
    const result = body.full
      ? await syncNowWithOptions(body.locationId, {
          full: true,
          createDrafts: body.createDrafts,
        })
      : await syncNow(body.locationId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/kpis", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { data, error } = await supabase.from("dashboard_kpis").select("*");
    if (error) throw error;
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/daily", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { data, error } = await supabase.from("dashboard_daily_volume").select("*");
    if (error) throw error;
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/usage", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const rawInput = Number(process.env.OPENAI_PRICE_INPUT_PER_1M ?? "0.15");
    const rawOutput = Number(process.env.OPENAI_PRICE_OUTPUT_PER_1M ?? "0.60");
    const rawFx = Number(process.env.USD_TO_EUR_RATE ?? "0.92");
    const priceInputPer1M = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0.15;
    const priceOutputPer1M = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0.60;
    const usdToEur = Number.isFinite(rawFx) && rawFx > 0 ? rawFx : 0.92;
    const blendedPer1M = (priceInputPer1M + priceOutputPer1M) / 2;

    const { data, error } = await supabase
      .from("drafts")
      .select("tokens, cost_eur");
    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    const tokensTotal = rows.reduce(
      (sum, row) => sum + Number((row as { tokens?: number }).tokens ?? 0),
      0
    );
    const costTotal = rows.reduce(
      (sum, row) => sum + Number((row as { cost_eur?: number }).cost_eur ?? 0),
      0
    );
    const estimated = tokensTotal
      ? (tokensTotal * blendedPer1M) / 1_000_000 * usdToEur
      : 0;
    const useEstimated =
      tokensTotal > 0 && (costTotal <= 0 || costTotal < estimated * 0.5);

    res.json({
      tokensTotal,
      costTotal: useEstimated ? estimated : costTotal,
      estimated: useEstimated,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/drafts", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const rawInput = Number(process.env.OPENAI_PRICE_INPUT_PER_1M ?? "0.15");
    const rawOutput = Number(process.env.OPENAI_PRICE_OUTPUT_PER_1M ?? "0.60");
    const rawFx = Number(process.env.USD_TO_EUR_RATE ?? "0.92");
    const priceInputPer1M = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0.15;
    const priceOutputPer1M = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0.60;
    const usdToEur = Number.isFinite(rawFx) && rawFx > 0 ? rawFx : 0.92;
    const blendedPer1M = (priceInputPer1M + priceOutputPer1M) / 2;
    const { data: overview, error: overviewError } = await supabase
      .from("drafts_overview")
      .select("*")
      .order("draft_created_at", { ascending: false })
      .limit(50);
    if (overviewError) {
      const { data, error } = await supabase
        .from("dashboard_drafts_recent")
        .select("*")
        .limit(50);
      if (error) throw error;
      res.json({ data });
      return;
    }
    const data = (overview ?? []).map((row: { cost_eur?: number | null; tokens?: number | null }) => {
      const tokens = Number(row.tokens ?? 0);
      const current = Number(row.cost_eur ?? 0);
      if (tokens > 0) {
        const estimated = (tokens * blendedPer1M) / 1_000_000 * usdToEur;
        if (!Number.isFinite(current) || current <= 0 || current < estimated * 0.5) {
          return { ...row, cost_eur: Number.isFinite(estimated) ? estimated : row.cost_eur };
        }
      }
      return row;
    });
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/lost-drafts", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const rawInput = Number(process.env.OPENAI_PRICE_INPUT_PER_1M ?? "0.15");
    const rawOutput = Number(process.env.OPENAI_PRICE_OUTPUT_PER_1M ?? "0.60");
    const rawFx = Number(process.env.USD_TO_EUR_RATE ?? "0.92");
    const priceInputPer1M = Number.isFinite(rawInput) && rawInput > 0 ? rawInput : 0.15;
    const priceOutputPer1M = Number.isFinite(rawOutput) && rawOutput > 0 ? rawOutput : 0.60;
    const usdToEur = Number.isFinite(rawFx) && rawFx > 0 ? rawFx : 0.92;
    const blendedPer1M = (priceInputPer1M + priceOutputPer1M) / 2;

    const { data: overview, error: overviewError } = await supabase
      .from("dashboard_lost_drafts_recent")
      .select("*")
      .order("lost_created_at", { ascending: false })
      .limit(50);
    if (overviewError) {
      const { data, error } = await supabase
        .from("lost_drafts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      res.json({ data });
      return;
    }

    const data = (overview ?? []).map((row: { cost_eur?: number | null; tokens?: number | null }) => {
      const tokens = Number(row.tokens ?? 0);
      const current = Number(row.cost_eur ?? 0);
      if (tokens > 0) {
        const estimated = (tokens * blendedPer1M) / 1_000_000 * usdToEur;
        if (!Number.isFinite(current) || current <= 0 || current < estimated * 0.5) {
          return { ...row, cost_eur: Number.isFinite(estimated) ? estimated : row.cost_eur };
        }
      }
      return row;
    });
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dns", async (req, res, next) => {
  const schema = z.object({
    provider: z.string().optional(),
    domain: z.string().min(1),
    txtRecords: z.array(z.object({ name: z.string(), value: z.string() })),
    mxRecords: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
        priority: z.string(),
      })
    ),
    cname: z.object({ name: z.string(), value: z.string() }),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const body = schema.parse(req.body);
    const txtRecords = body.txtRecords.filter(
      (record) => record.name.trim() && record.value.trim()
    );
    const mxRecords = body.mxRecords.filter(
      (record) => record.name.trim() && record.value.trim() && record.priority.trim()
    );
    const cnameRecord =
      body.cname.name.trim() && body.cname.value.trim() ? body.cname : null;
    const { error } = await supabase.from("dns_records").insert({
      provider: body.provider ?? "mailgun",
      domain: body.domain,
      txt_records: txtRecords,
      mx_records: mxRecords,
      cname_record: cnameRecord,
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/twilio/send", async (req, res, next) => {
  const schema = z.object({
    to: z.string().min(3),
    body: z.string().min(1),
  });
  try {
    const payload = schema.parse(req.body);
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_FROM_NUMBER;
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

    if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) {
      res.status(500).json({
        error: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID.",
      });
      return;
    }

    const client = twilio(accountSid, authToken);
    const message = await client.messages.create({
      to: payload.to,
      body: payload.body,
      ...(messagingServiceSid ? { messagingServiceSid } : { from: fromNumber }),
    });

    const supabase = getSupabaseClient();
    if (supabase) {
      await supabase.from("sms_events").insert({
        provider: "twilio",
        to_phone: payload.to,
        from_phone: fromNumber ?? null,
        body: payload.body,
        status: message.status ?? "sent",
        provider_id: message.sid ?? null,
        metadata: message ?? null,
      });
    }

    res.json({ success: true, sid: message.sid, status: message.status });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mailgun/send", async (req, res, next) => {
  const schema = z.object({
    to: z.string().min(3),
    subject: z.string().min(1),
    text: z.string().min(1),
  });
  try {
    const body = schema.parse(req.body);
    const apiKey = process.env.MAILGUN_API_KEY;
    const domain = process.env.MAILGUN_DOMAIN;
    const baseUrl = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net";
    const from =
      process.env.MAILGUN_FROM || (domain ? `no-reply@${domain}` : "");

    if (!apiKey || !domain || !from) {
      res.status(500).json({
        error: "Mailgun is not configured. Set MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM.",
      });
      return;
    }

    const params = new URLSearchParams();
    params.set("from", from);
    params.set("to", body.to);
    params.set("subject", body.subject);
    params.set("text", body.text);

    const supabase = getSupabaseClient();
    const normalizedTo = extractEmail(body.to) ?? body.to;
    if (supabase && normalizedTo) {
      try {
        const [{ data: inbound, error: inboundError }, { data: outbound, error: outboundError }] =
          await Promise.all([
            supabase
              .from("mail_inbound")
              .select("message_id, timestamp, created_at")
              .or(`from_email.eq.${normalizedTo},from_email.ilike.%${normalizedTo}%`)
              .order("created_at", { ascending: false })
              .limit(1),
            supabase
              .from("mail_events")
              .select("provider_id, created_at")
              .or(`to_email.eq.${normalizedTo},to_email.ilike.%${normalizedTo}%`)
              .order("created_at", { ascending: false })
              .limit(1),
          ]);

        if (!inboundError && !outboundError) {
          const inboundMsg = inbound?.[0];
          const outboundMsg = outbound?.[0];
          const inboundTime = inboundMsg?.timestamp ?? inboundMsg?.created_at ?? null;
          const outboundTime = outboundMsg?.created_at ?? null;
          const inboundMs = inboundTime ? new Date(inboundTime).getTime() : 0;
          const outboundMs = outboundTime ? new Date(outboundTime).getTime() : 0;
          const replyId =
            inboundMs >= outboundMs
              ? inboundMsg?.message_id ?? outboundMsg?.provider_id
              : outboundMsg?.provider_id ?? inboundMsg?.message_id;
          if (replyId) {
            params.set("h:In-Reply-To", replyId);
            params.set("h:References", replyId);
          }
        }
      } catch {
        // If threading lookup fails, still send the message.
      }
    }

    const response = await axios.post(
      `${baseUrl}/v3/${domain}/messages`,
      params,
      {
        auth: { username: "api", password: apiKey },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    if (supabase) {
      await supabase.from("mail_events").insert({
        provider: "mailgun",
        to_email: extractEmail(body.to) ?? body.to,
        from_email: extractEmail(from) ?? from,
        subject: body.subject,
        status: "sent",
        provider_id: response.data?.id ?? null,
        metadata: { ...(response.data ?? {}), text: body.text, subject: body.subject },
      });
    }

    res.json({ success: true, id: response.data?.id, message: response.data?.message });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mailgun/status", async (req, res, next) => {
  const schema = z.object({ email: z.string().optional(), phone: z.string().optional() });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { email, phone } = schema.parse(req.query);
    const normalizedEmail = email ? email.toLowerCase() : undefined;
    const normalizedPhone = phone ? phone.replace(/\D/g, "") : undefined;
    if (!normalizedEmail && !normalizedPhone) {
      res.json({ data: [] });
      return;
    }
    const { data, error } = await supabase
      .from("mail_events")
      .select("*")
      .eq("to_email", email)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mailgun/inbox", async (req, res, next) => {
  const schema = z.object({ email: z.string().optional(), phone: z.string().optional() });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { email, phone } = schema.parse(req.query);
    const normalizedEmail = email ? email.toLowerCase() : undefined;
    const normalizedPhone = phone ? phone.replace(/\D/g, "") : undefined;
    if (!normalizedEmail && !normalizedPhone) {
      res.json({ data: [] });
      return;
    }
    const { data, error } = await supabase
      .from("mail_inbound")
      .select("*")
      .or(`from_email.eq.${normalizedEmail},from_email.ilike.%${normalizedEmail}%`)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mailgun/thread", async (req, res, next) => {
  const schema = z.object({ email: z.string().optional(), phone: z.string().optional() });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { email, phone } = schema.parse(req.query);
    const normalizedEmail = email ? email.toLowerCase() : undefined;
    const normalizedPhone = phone ? phone.replace(/\D/g, "") : undefined;
    if (!normalizedEmail && !normalizedPhone) {
      res.json({ data: [] });
      return;
    }

    const [{ data: outbound, error: outboundError }, { data: inbound, error: inboundError }, { data: smsOut, error: smsOutError }, { data: smsIn, error: smsInError }] = await Promise.all([
      supabase
        .from("mail_events")
        .select("id, to_email, from_email, subject, created_at, metadata, provider_id")
        .or(
          normalizedEmail
            ? `to_email.eq.${normalizedEmail},to_email.ilike.%${normalizedEmail}%`
            : "id.is.null"
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("mail_inbound")
        .select("id, from_email, to_email, subject, body_plain, body_html, created_at, timestamp")
        .or(
          normalizedEmail
            ? `from_email.eq.${normalizedEmail},from_email.ilike.%${normalizedEmail}%`
            : "id.is.null"
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("sms_events")
        .select("id, to_phone, from_phone, body, created_at, provider_id")
        .or(normalizedPhone ? `to_phone.ilike.%${normalizedPhone}%` : "id.is.null")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("sms_inbound")
        .select("id, from_phone, to_phone, body, created_at, timestamp")
        .or(normalizedPhone ? `from_phone.ilike.%${normalizedPhone}%` : "id.is.null")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    if (outboundError) throw outboundError;
    if (inboundError) throw inboundError;
    if (smsOutError) throw smsOutError;
    if (smsInError) throw smsInError;

    const outboundMessages = (outbound ?? []).map((item) => ({
      id: item.id,
      direction: "outbound",
      from_email: item.from_email,
      to_email: item.to_email,
      subject: item.subject,
      body: (item.metadata && (item.metadata.text || item.metadata.body)) || "",
      timestamp: item.created_at,
      provider_id: item.provider_id ?? null,
    }));

    const inboundMessages = (inbound ?? []).map((item) => ({
      id: item.id,
      direction: "inbound",
      from_email: item.from_email,
      to_email: item.to_email,
      subject: item.subject,
      body: cleanEmailReply(item.body_plain) || item.body_plain || "",
      timestamp: item.timestamp || item.created_at,
      provider_id: null,
    }));

    const smsOutMessages = (smsOut ?? []).map((item) => ({
      id: item.id,
      direction: "outbound",
      from_phone: item.from_phone,
      to_phone: item.to_phone,
      subject: "SMS",
      body: item.body || "",
      timestamp: item.created_at,
      provider_id: item.provider_id ?? null,
      type: "SMS",
    }));

    const smsInMessages = (smsIn ?? []).map((item) => ({
      id: item.id,
      direction: "inbound",
      from_phone: item.from_phone,
      to_phone: item.to_phone,
      subject: "SMS",
      body: item.body || "",
      timestamp: item.timestamp || item.created_at,
      provider_id: null,
      type: "SMS",
    }));

    const data = [...outboundMessages, ...inboundMessages, ...smsOutMessages, ...smsInMessages].sort((a, b) => {
      const at = new Date(a.timestamp ?? 0).getTime();
      const bt = new Date(b.timestamp ?? 0).getTime();
      return at - bt;
    });

    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/crm/leads", async (req, res, next) => {
  const schema = z.object({
    status: z.string().optional(),
    q: z.string().optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { status, q, limit, offset } = schema.parse(req.query);
    const take = limit ? Math.min(Number(limit), 100) : 50;
    const skip = offset ? Math.max(Number(offset), 0) : 0;
    const view = "crm_leads_activity";
    let query = supabase
      .from(view)
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(skip, skip + take - 1);

    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      query = query.or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`);
    }

    const { data, error, count } = await query;
    if (error) {
      if (error.code === "42P01" || error.message?.includes("does not exist")) {
        throw new Error("CRM views ontbreken. Run server/db/crm.sql in Supabase.");
      }
      throw new Error(error.message);
    }

    let filtered = data ?? [];
    if (status === "open") {
      filtered = filtered.filter((lead) => {
        if (!lead.last_outbound_at) return false;
        if (!lead.last_inbound_at) return true;
        return new Date(lead.last_inbound_at).getTime() < new Date(lead.last_outbound_at).getTime();
      });
    } else if (status === "replied") {
      filtered = filtered.filter((lead) => {
        if (!lead.last_inbound_at) return false;
        if (!lead.last_outbound_at) return true;
        return new Date(lead.last_inbound_at).getTime() >= new Date(lead.last_outbound_at).getTime();
      });
    }

    res.json({ data: filtered, total: count ?? filtered.length });
  } catch (error) {
    next(error);
  }
});

app.post("/api/crm/leads", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    status: z.string().optional(),
    owner: z.string().optional(),
    source: z.string().optional(),
    pipelineStage: z.string().optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const body = schema.parse(req.body);
    const { data, error } = await supabase
      .from("crm_leads")
      .insert({
        name: body.name,
        email: body.email ? body.email.toLowerCase() : null,
        phone: body.phone ?? null,
        status: body.status ?? "Nieuw",
        owner: body.owner ?? "Onbekend",
        source: body.source ?? null,
        pipeline_stage: body.pipelineStage ?? null,
      })
      .select("*")
      .single();
    if (error) {
      throw new Error(error.message);
    }
    res.json({ lead: data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/crm/auto-reply-rules", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { data, error } = await supabase
      .from("auto_reply_rules")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ data: data ?? [] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/crm/auto-reply-rules", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    channel: z.enum(["email", "sms", "both"]).optional(),
    enabled: z.boolean().optional(),
    delayMinutes: z.number().int().nonnegative().optional(),
    businessHoursOnly: z.boolean().optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const body = schema.parse(req.body);
    const { data, error } = await supabase
      .from("auto_reply_rules")
      .insert({
        name: body.name,
        prompt: body.prompt,
        channel: body.channel ?? "both",
        enabled: body.enabled ?? true,
        delay_minutes: body.delayMinutes ?? 0,
        business_hours_only: body.businessHoursOnly ?? false,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    res.json({ rule: data });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/crm/auto-reply-rules/:id", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    channel: z.enum(["email", "sms", "both"]).optional(),
    enabled: z.boolean().optional(),
    delayMinutes: z.number().int().nonnegative().optional(),
    businessHoursOnly: z.boolean().optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const body = schema.parse(req.body);
    const payload: Record<string, unknown> = {};
    if (body.name !== undefined) payload.name = body.name;
    if (body.prompt !== undefined) payload.prompt = body.prompt;
    if (body.channel !== undefined) payload.channel = body.channel;
    if (body.enabled !== undefined) payload.enabled = body.enabled;
    if (body.delayMinutes !== undefined) payload.delay_minutes = body.delayMinutes;
    if (body.businessHoursOnly !== undefined)
      payload.business_hours_only = body.businessHoursOnly;
    const { data, error } = await supabase
      .from("auto_reply_rules")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    res.json({ rule: data });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/crm/auto-reply-rules/:id", async (req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const { error } = await supabase.from("auto_reply_rules").delete().eq("id", id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/crm/automations", async (_req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { data, error } = await supabase
      .from("crm_automations")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ data: data ?? [] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/crm/automations", async (req, res, next) => {
  const stepSchema = z.object({
    id: z.string().optional(),
    type: z.enum(["trigger", "wait", "email", "sms"]),
    config: z.record(z.unknown()).optional(),
  });
  const schema = z.object({
    name: z.string().min(1),
    triggerType: z.string().optional(),
    triggerValue: z.string().optional(),
    channel: z.enum(["email", "sms", "both"]).optional(),
    emailSubject: z.string().optional(),
    emailBody: z.string().optional(),
    smsBody: z.string().optional(),
    delayMinutes: z.number().int().nonnegative().optional(),
    businessHoursOnly: z.boolean().optional(),
    enabled: z.boolean().optional(),
    steps: z.array(stepSchema).optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const body = schema.parse(req.body);
    const { data, error } = await supabase
      .from("crm_automations")
      .insert({
        name: body.name,
        trigger_type: body.triggerType ?? "stage",
        trigger_value: body.triggerValue ?? null,
        channel: body.channel ?? "both",
        email_subject: body.emailSubject ?? null,
        email_body: body.emailBody ?? null,
        sms_body: body.smsBody ?? null,
        delay_minutes: body.delayMinutes ?? 0,
        business_hours_only: body.businessHoursOnly ?? false,
        enabled: body.enabled ?? true,
        steps: body.steps ?? [],
      })
      .select("*")
      .single();
    if (error) {
      if (error.message.toLowerCase().includes("steps")) {
        throw new Error(
          "Supabase mist de kolom 'steps'. Run server/db/automations.sql opnieuw."
        );
      }
      throw new Error(error.message);
    }
    res.json({ automation: data });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/crm/automations/:id", async (req, res, next) => {
  const stepSchema = z.object({
    id: z.string().optional(),
    type: z.enum(["trigger", "wait", "email", "sms"]),
    config: z.record(z.unknown()).optional(),
  });
  const schema = z.object({
    name: z.string().min(1).optional(),
    triggerType: z.string().optional(),
    triggerValue: z.string().optional(),
    channel: z.enum(["email", "sms", "both"]).optional(),
    emailSubject: z.string().optional(),
    emailBody: z.string().optional(),
    smsBody: z.string().optional(),
    delayMinutes: z.number().int().nonnegative().optional(),
    businessHoursOnly: z.boolean().optional(),
    enabled: z.boolean().optional(),
    steps: z.array(stepSchema).optional(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const body = schema.parse(req.body);
    const payload: Record<string, unknown> = {};
    if (body.name !== undefined) payload.name = body.name;
    if (body.triggerType !== undefined) payload.trigger_type = body.triggerType;
    if (body.triggerValue !== undefined) payload.trigger_value = body.triggerValue;
    if (body.channel !== undefined) payload.channel = body.channel;
    if (body.emailSubject !== undefined) payload.email_subject = body.emailSubject;
    if (body.emailBody !== undefined) payload.email_body = body.emailBody;
    if (body.smsBody !== undefined) payload.sms_body = body.smsBody;
    if (body.delayMinutes !== undefined) payload.delay_minutes = body.delayMinutes;
    if (body.businessHoursOnly !== undefined)
      payload.business_hours_only = body.businessHoursOnly;
    if (body.enabled !== undefined) payload.enabled = body.enabled;
    if (body.steps !== undefined) payload.steps = body.steps;

    const { data, error } = await supabase
      .from("crm_automations")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();
    if (error) {
      if (error.message.toLowerCase().includes("steps")) {
        throw new Error(
          "Supabase mist de kolom 'steps'. Run server/db/automations.sql opnieuw."
        );
      }
      throw new Error(error.message);
    }
    res.json({ automation: data });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/crm/automations/:id", async (req, res, next) => {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const { error } = await supabase.from("crm_automations").delete().eq("id", id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/crm/leads/:id", async (req, res, next) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional().nullable(),
    phone: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    owner: z.string().optional().nullable(),
    source: z.string().optional().nullable(),
    pipelineStage: z.string().optional().nullable(),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }
    const { id } = req.params;
    const body = schema.parse(req.body);
    const payload: Record<string, unknown> = {};
    if (body.name !== undefined) payload.name = body.name;
    if (body.email !== undefined)
      payload.email = body.email ? body.email.toLowerCase() : null;
    if (body.phone !== undefined) payload.phone = body.phone ?? null;
    if (body.status !== undefined) payload.status = body.status ?? null;
    if (body.owner !== undefined) payload.owner = body.owner ?? null;
    if (body.source !== undefined) payload.source = body.source ?? null;
    if (body.pipelineStage !== undefined)
      payload.pipeline_stage = body.pipelineStage ?? null;

    const { data, error } = await supabase
      .from("crm_leads")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();
    if (error) {
      throw new Error(error.message);
    }
    res.json({ lead: data });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mailgun/suggest", async (req, res, next) => {
  const schema = z.object({
    email: z.string().email().optional().nullable().or(z.literal("")),
    channel: z.enum(["email", "sms"]).optional(),
    lead: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email().optional().nullable().or(z.literal("")),
      phone: z.string().optional().nullable(),
      status: z.string().optional().nullable(),
      owner: z.string().optional().nullable(),
      createdAt: z.string().optional().nullable(),
      source: z.string().optional().nullable(),
      pipelineStage: z.string().optional().nullable(),
    }),
  });
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }

    const body = schema.parse(req.body);
    const targetEmail = (body.email ?? body.lead.email ?? "")
      .toLowerCase()
      .trim();
    const targetPhone = body.lead.phone ? body.lead.phone.replace(/\D/g, "") : "";
    if (!targetEmail && !targetPhone) {
      res.status(400).json({ error: "Missing lead email or phone." });
      return;
    }

    const [{ data: outbound, error: outboundError }, { data: inbound, error: inboundError }, { data: smsOut, error: smsOutError }, { data: smsIn, error: smsInError }] = await Promise.all([
      supabase
        .from("mail_events")
        .select("id, to_email, from_email, subject, created_at, metadata, provider_id")
        .or(
          targetEmail
            ? `to_email.eq.${targetEmail},to_email.ilike.%${targetEmail}%`
            : "id.is.null"
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("mail_inbound")
        .select("id, from_email, to_email, subject, body_plain, body_html, created_at, timestamp")
        .or(
          targetEmail
            ? `from_email.eq.${targetEmail},from_email.ilike.%${targetEmail}%`
            : "id.is.null"
        )
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("sms_events")
        .select("id, to_phone, from_phone, body, created_at, provider_id")
        .or(targetPhone ? `to_phone.ilike.%${targetPhone}%` : "id.is.null")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("sms_inbound")
        .select("id, from_phone, to_phone, body, created_at, timestamp")
        .or(targetPhone ? `from_phone.ilike.%${targetPhone}%` : "id.is.null")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    if (outboundError) throw outboundError;
    if (inboundError) throw inboundError;
    if (smsOutError) throw smsOutError;
    if (smsInError) throw smsInError;

    const outboundMessages = (outbound ?? []).map((item) => ({
      id: item.id,
      direction: "outbound",
      body: (item.metadata && (item.metadata.text || item.metadata.body)) || "",
      subject: item.subject,
      timestamp: item.created_at,
      type: "EMAIL",
    }));

    const inboundMessages = (inbound ?? []).map((item) => ({
      id: item.id,
      direction: "inbound",
      body: cleanEmailReply(item.body_plain) || item.body_plain || "",
      subject: item.subject,
      timestamp: item.timestamp || item.created_at,
      type: "EMAIL",
    }));

    const smsOutMessages = (smsOut ?? []).map((item) => ({
      id: item.id,
      direction: "outbound",
      body: item.body || "",
      subject: "SMS",
      timestamp: item.created_at,
      type: "SMS",
    }));

    const smsInMessages = (smsIn ?? []).map((item) => ({
      id: item.id,
      direction: "inbound",
      body: item.body || "",
      subject: "SMS",
      timestamp: item.timestamp || item.created_at,
      type: "SMS",
    }));

    const messages = [...outboundMessages, ...inboundMessages, ...smsOutMessages, ...smsInMessages].sort((a, b) => {
      const at = new Date(a.timestamp ?? 0).getTime();
      const bt = new Date(b.timestamp ?? 0).getTime();
      return at - bt;
    });

    const { data: rules, error: rulesError } = await supabase
      .from("auto_reply_rules")
      .select("*")
      .eq("enabled", true);
    if (rulesError) {
      throw new Error(rulesError.message);
    }

    const channel = body.channel ?? "email";
    const filteredRules =
      rules?.filter((rule) => rule.channel === "both" || rule.channel === channel) ?? [];

    const suggestion = await suggestCrmReply({
      lead: body.lead,
      messages,
      rules: filteredRules,
      channel,
    });
    res.json(suggestion);
  } catch (error) {
    next(error);
  }
});

app.post("/api/mailgun/webhook/inbound", mailgunUpload.none(), async (req, res, next) => {
  try {
    const signingKey = process.env.MAILGUN_SIGNING_KEY;
    if (!signingKey) {
      res.status(500).json({ error: "MAILGUN_SIGNING_KEY not configured." });
      return;
    }

    const timestamp = req.body?.timestamp;
    const token = req.body?.token;
    const signature = req.body?.signature;
    if (!timestamp || !token || !signature) {
      res.status(400).json({ error: "Missing Mailgun signature." });
      return;
    }

    const hmac = crypto
      .createHmac("sha256", signingKey)
      .update(`${timestamp}${token}`)
      .digest("hex");
    if (hmac !== signature) {
      res.status(403).json({ error: "Invalid signature." });
      return;
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }

    const record = {
      provider: "mailgun",
      message_id: req.body?.["Message-Id"] ?? null,
      from_email: extractEmail(req.body?.sender ?? req.body?.from) ?? null,
      to_email: extractEmail(req.body?.recipient ?? req.body?.to) ?? null,
      subject: req.body?.subject ?? null,
      body_plain: req.body?.["body-plain"] ?? null,
      body_html: req.body?.["body-html"] ?? null,
      timestamp: req.body?.timestamp ? new Date(Number(req.body.timestamp) * 1000).toISOString() : null,
      raw: req.body ?? null,
    };

    const { error } = await supabase.from("mail_inbound").insert(record);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/twilio/webhook/inbound", async (req, res, next) => {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const signature = req.headers["x-twilio-signature"];
    if (authToken && typeof signature === "string") {
      const forwardedProto = req.headers["x-forwarded-proto"];
      const forwardedHost = req.headers["x-forwarded-host"];
      const protocol =
        typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : req.protocol;
      const host =
        typeof forwardedHost === "string" ? forwardedHost.split(",")[0] : req.get("host");
      const url = `${protocol}://${host}${req.originalUrl}`;

      const isValid = twilio.validateRequest(authToken, signature, url, req.body ?? {});
      if (!isValid) {
        res.status(403).json({ error: "Invalid Twilio signature." });
        return;
      }
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured." });
      return;
    }

    const record = {
      provider: "twilio",
      message_id: req.body?.MessageSid ?? null,
      from_phone: req.body?.From ?? null,
      to_phone: req.body?.To ?? null,
      body: req.body?.Body ?? null,
      timestamp: req.body?.DateSent || req.body?.DateCreated || null,
      raw: req.body ?? null,
    };

    const { error } = await supabase.from("sms_inbound").insert(record);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/conversations/messages", async (req, res, next) => {
  const schema = z.object({
    conversationId: z.string().optional(),
    contactId: z.string().optional(),
    channel: z.enum(["SMS", "EMAIL"]),
    body: z.string().min(1),
    subject: z.string().optional(),
    locationId: z.string().optional(),
  });

  try {
    const body = schema.parse(req.body);
    const config = getGhlConfig(body.locationId);
    const result = await sendMessage(config, body);
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/suggest", async (req, res, next) => {
  const schema = z.object({
    conversationId: z.string(),
    contactId: z.string(),
    locationId: z.string().optional(),
  });

  try {
    const body = schema.parse(req.body);
    const config = getGhlConfig(body.locationId);

    const [contact, conversation, messages] = await Promise.all([
      getContactById(config, body.contactId),
      getConversationById(config, body.conversationId),
      listAllMessages(config, body.conversationId, 200),
    ]);

    const suggestion = await suggestReply({
      contact,
      conversation,
      messages,
      maxMessages: 200,
    });

    res.json({ suggestion });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof GhlError) {
    res.status(error.status ?? 500).json({ error: error.userMessage });
    return;
  }

  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Ongeldige invoer.", details: error.errors });
    return;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message)
      : "Unknown error";
  res.status(500).json({ error: message });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

if (process.env.SYNC_ENABLED === "true") {
  startBackgroundSync();
}
