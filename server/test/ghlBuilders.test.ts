import { describe, it, expect } from "vitest";
import { buildSendMessagePayload } from "../src/ghl/sendMessage.js";
import { getNextMessagesQuery } from "../src/ghl/pagination.js";

describe("buildSendMessagePayload", () => {
  it("builds SMS payload with conversationId", () => {
    const payload = buildSendMessagePayload({
      conversationId: "conv_123",
      channel: "SMS",
      body: "Hallo!",
    });

    expect(payload).toMatchObject({
      conversationId: "conv_123",
      type: "SMS",
      message: "Hallo!",
    });
  });

  it("requires subject for email", () => {
    expect(() =>
      buildSendMessagePayload({
        contactId: "contact_1",
        channel: "EMAIL",
        body: "Hallo",
      })
    ).toThrow("Email subject is required");
  });
});

describe("getNextMessagesQuery", () => {
  it("returns null when no next page", () => {
    const query = getNextMessagesQuery({ nextPage: false }, 20);
    expect(query).toBeNull();
  });

  it("returns cursor params when next page exists", () => {
    const query = getNextMessagesQuery(
      { nextPage: true, lastMessageId: "msg_99" },
      30
    );

    expect(query).toEqual({ limit: 30, lastMessageId: "msg_99" });
  });
});
