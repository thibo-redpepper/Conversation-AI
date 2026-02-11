import twilio from "twilio";
import { getSupabaseClient } from "../supabase/client.js";

export const sendSmsViaTwilio = async (input: { to: string; body: string }) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) {
    throw new Error(
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID."
    );
  }

  const client = twilio(accountSid, authToken);
  const message = await client.messages.create({
    to: input.to,
    body: input.body,
    ...(messagingServiceSid ? { messagingServiceSid } : { from: fromNumber }),
  });

  const supabase = getSupabaseClient();
  if (supabase) {
    await supabase.from("sms_events").insert({
      provider: "twilio",
      to_phone: input.to,
      from_phone: fromNumber ?? null,
      body: input.body,
      status: message.status ?? "sent",
      provider_id: message.sid ?? null,
      metadata: message ?? null,
    });
  }

  return {
    provider: "twilio",
    sid: message.sid,
    status: message.status,
    to: message.to ?? input.to,
    from: message.from ?? null,
    messagingServiceSid: message.messagingServiceSid ?? null,
  };
};
