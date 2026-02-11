import axios from "axios";
import { getSupabaseClient } from "../supabase/client.js";
import { extractEmail } from "../shared/email.js";

export const sendEmailViaMailgun = async (input: {
  to: string;
  subject: string;
  text: string;
}) => {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const baseUrl = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net";
  const from = process.env.MAILGUN_FROM || (domain ? `no-reply@${domain}` : "");

  if (!apiKey || !domain || !from) {
    throw new Error(
      "Mailgun is not configured. Set MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM."
    );
  }

  const params = new URLSearchParams();
  params.set("from", from);
  params.set("to", input.to);
  params.set("subject", input.subject);
  params.set("text", input.text);

  const supabase = getSupabaseClient();
  const normalizedTo = extractEmail(input.to) ?? input.to;
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

  const response = await axios.post(`${baseUrl}/v3/${domain}/messages`, params, {
    auth: { username: "api", password: apiKey },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (supabase) {
    await supabase.from("mail_events").insert({
      provider: "mailgun",
      to_email: extractEmail(input.to) ?? input.to,
      from_email: extractEmail(from) ?? from,
      subject: input.subject,
      status: "sent",
      provider_id: response.data?.id ?? null,
      metadata: { ...(response.data ?? {}), text: input.text, subject: input.subject },
    });
  }

  return {
    provider: "mailgun",
    id: response.data?.id ?? null,
    message: response.data?.message ?? null,
  };
};

