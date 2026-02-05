import { z } from "zod";
import { createGhlClient, GhlConfig, mapGhlError } from "./client.js";

export type SendMessageChannel = "SMS" | "EMAIL";

export type SendMessageInput = {
  conversationId?: string;
  contactId?: string;
  channel: SendMessageChannel;
  body: string;
  subject?: string;
  locationId?: string;
};

export const buildSendMessagePayload = (input: SendMessageInput) => {
  if (!input.conversationId && !input.contactId) {
    throw new Error("conversationId or contactId is required");
  }

  if (!input.body?.trim()) {
    throw new Error("Message body is required");
  }

  if (input.channel === "EMAIL" && !input.subject?.trim()) {
    throw new Error("Email subject is required");
  }

  const isEmail = input.channel === "EMAIL";
  const type = isEmail ? "Email" : "SMS";
  const htmlBody = input.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${line}</p>`)
    .join("");

  return {
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
    type,
    ...(isEmail ? { subject: input.subject, html: htmlBody || "<p></p>" } : {}),
    ...(isEmail ? {} : { message: input.body }),
  };
};

const SendResponseSchema = z.object({
  messageId: z.string().optional(),
  emailMessageId: z.string().optional(),
});

export const sendMessage = async (config: GhlConfig, input: SendMessageInput) => {
  try {
    const payload = buildSendMessagePayload({
      ...input,
      locationId: config.locationId,
    });
    const client = createGhlClient(config);
    const response = await client.post("/conversations/messages", payload);

    const parsed = SendResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      return { messageId: undefined, emailMessageId: undefined };
    }

    return {
      messageId: parsed.data.messageId,
      emailMessageId: parsed.data.emailMessageId,
    };
  } catch (error) {
    throw mapGhlError(error);
  }
};
