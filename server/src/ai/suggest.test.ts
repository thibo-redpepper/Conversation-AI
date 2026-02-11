import { describe, expect, it } from "vitest";
import {
  countTrailingOutboundWithoutInbound,
  normalizeAgentProfile,
  renderContactTemplate,
  suggestReply,
} from "./suggest.js";
import type { Message } from "../shared/types.js";

const baseMessage = (overrides: Partial<Message>): Message => ({
  id: "m1",
  conversationId: "c1",
  contactId: "ct1",
  type: "TYPE_SMS",
  direction: "inbound",
  body: "",
  timestamp: new Date("2026-01-01T12:00:00.000Z").toISOString(),
  ...overrides,
});

describe("normalizeAgentProfile", () => {
  it("clamps numeric settings and cleans arrays", () => {
    const profile = normalizeAgentProfile({
      name: "  Test Agent  ",
      assertiveness: 140,
      responseSpeed: "VeryFast",
      maxFollowUps: -2,
      intervalHours: 9999,
      followUpScheduleHours: [12, -4, 9999, 36],
      qualificationCriteria: [" Budget ", "", "Budget", "Eigenaar woning"],
      websites: [" https://example.com ", "https://example.com"],
      faqs: [{ question: " Q1 ", answer: " A1 " }, { question: "", answer: "skip" }],
    });

    expect(profile).not.toBeNull();
    expect(profile?.name).toBe("Test Agent");
    expect(profile?.assertiveness).toBe(100);
    expect(profile?.responseSpeed).toBe("Natural");
    expect(profile?.maxFollowUps).toBe(4);
    expect(profile?.intervalHours).toBe(12);
    expect(profile?.followUpScheduleHours).toEqual([12, 0, 720, 36]);
    expect(profile?.qualificationCriteria).toEqual(["Budget", "Eigenaar woning"]);
    expect(profile?.websites).toEqual(["https://example.com"]);
    expect(profile?.faqs).toEqual([{ question: "Q1", answer: "A1" }]);
  });

  it("supports instant follow-up interval", () => {
    const profile = normalizeAgentProfile({
      name: "Instant Agent",
      intervalHours: 0,
    });

    expect(profile).not.toBeNull();
    expect(profile?.intervalHours).toBe(0);
  });
});

describe("countTrailingOutboundWithoutInbound", () => {
  it("counts only unanswered trailing outbound messages", () => {
    const messages: Message[] = [
      baseMessage({ id: "i1", direction: "inbound", body: "Hallo" }),
      baseMessage({ id: "o1", direction: "outbound", body: "Hi", timestamp: "2026-01-01T12:01:00.000Z" }),
      baseMessage({ id: "o2", direction: "outbound", body: "Nog even", timestamp: "2026-01-01T12:02:00.000Z" }),
    ];
    expect(countTrailingOutboundWithoutInbound(messages)).toBe(2);
  });
});

describe("suggestReply fallback policy", () => {
  it("applies response speed limits when API key is missing", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await suggestReply({
        contact: { id: "ct1", firstName: "Test" },
        conversation: { id: "c1" },
        messages: [
          baseMessage({ id: "i1", direction: "inbound", body: "Kan je meer info sturen?" }),
        ],
        agent: {
          responseSpeed: "Instant",
          language: "Nederlands",
        },
      });

      const sentences = result.text
        .split(/(?<=[.!?])\s+/)
        .filter((part) => part.trim().length > 0);
      expect(sentences.length).toBeLessThanOrEqual(2);
    } finally {
      if (previousKey) {
        process.env.OPENAI_API_KEY = previousKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  it("renders contact placeholders in firstMessage template", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await suggestReply({
        contact: { id: "ct1", firstName: "Lies", email: "lies@example.com", phone: "+32470000000" },
        conversation: { id: "c1" },
        messages: [baseMessage({ id: "o1", direction: "outbound", body: "Hi" })],
        agent: {
          firstMessage:
            "Hey {{contact.first_name}}, is dit je email: {{contact.email}} en gsm {{contact.phone}}?",
          responseSpeed: "Natural",
        },
      });

      expect(result.text).toContain("Lies");
      expect(result.text).toContain("lies@example.com");
      expect(result.text).toContain("+32470000000");
    } finally {
      if (previousKey) {
        process.env.OPENAI_API_KEY = previousKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });
});

describe("renderContactTemplate", () => {
  it("keeps unknown placeholders untouched", () => {
    const rendered = renderContactTemplate("Hallo {{contact.unknown}}", {
      id: "ct1",
      firstName: "Tom",
    });
    expect(rendered).toBe("Hallo {{contact.unknown}}");
  });
});
