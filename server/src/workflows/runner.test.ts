import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "./types.js";
import { runWorkflowTest } from "./runner.js";

describe("runWorkflowTest", () => {
  it("runs nodes in order and records wait without delaying", async () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
        { id: "w1", type: "action.wait", position: { x: 1, y: 0 }, data: { amount: 2, unit: "hours" } },
        {
          id: "e1",
          type: "action.email",
          position: { x: 2, y: 0 },
          data: { to: "a@example.com", subject: "Hi", body: "Body" },
        },
        { id: "s1", type: "action.sms", position: { x: 3, y: 0 }, data: { to: "+100", message: "Yo" } },
      ],
      edges: [
        { id: "e-t-w", source: "t1", target: "w1" },
        { id: "e-w-e", source: "w1", target: "e1" },
        { id: "e-e-s", source: "e1", target: "s1" },
      ],
    };

    const report = await runWorkflowTest({
      definition: def,
      sendEmail: async () => ({ providerMessageId: "mail-1" }),
      sendSms: async () => ({ providerMessageId: "sms-1" }),
    });

    expect(report.status).toBe("success");
    expect(report.steps.map((s) => s.nodeId)).toEqual(["t1", "w1", "e1", "s1"]);
    expect(report.steps.find((s) => s.nodeId === "w1")?.output).toEqual({
      amount: 2,
      unit: "hours",
    });
  });

  it("stops on first failing send", async () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
        {
          id: "e1",
          type: "action.email",
          position: { x: 1, y: 0 },
          data: { to: "a@example.com", subject: "Hi", body: "Body" },
        },
        { id: "s1", type: "action.sms", position: { x: 2, y: 0 }, data: { to: "+100", message: "Yo" } },
      ],
      edges: [
        { id: "e-t-e", source: "t1", target: "e1" },
        { id: "e-e-s", source: "e1", target: "s1" },
      ],
    };

    const report = await runWorkflowTest({
      definition: def,
      sendEmail: async () => {
        throw new Error("Mailgun down");
      },
      sendSms: async () => ({ providerMessageId: "sms-1" }),
    });

    expect(report.status).toBe("failed");
    expect(report.error?.nodeId).toBe("e1");
    expect(report.steps.map((s) => s.nodeId)).toEqual(["t1", "e1"]);
  });

  it("runs agent handoff module", async () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
        {
          id: "a1",
          type: "action.agent",
          position: { x: 1, y: 0 },
          data: { agentId: "agent-123", notes: "Neem over" },
        },
      ],
      edges: [{ id: "e-t-a", source: "t1", target: "a1" }],
    };

    const report = await runWorkflowTest({
      definition: def,
      sendEmail: async () => ({ providerMessageId: "mail-1" }),
      sendSms: async () => ({ providerMessageId: "sms-1" }),
      handoffToAgent: async ({ agentId, notes }) => ({
        handoff: "queued",
        resolvedAgentId: agentId,
        notes,
      }),
    });

    expect(report.status).toBe("success");
    expect(report.steps.map((s) => s.nodeId)).toEqual(["t1", "a1"]);
    expect(report.steps[1]?.output).toMatchObject({
      agentId: "agent-123",
      handoff: "queued",
      resolvedAgentId: "agent-123",
    });
  });

  it("infers EMAIL handoff channel from previous email action", async () => {
    const channels: Array<"SMS" | "EMAIL" | undefined> = [];
    const def: WorkflowDefinition = {
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
        {
          id: "e1",
          type: "action.email",
          position: { x: 1, y: 0 },
          data: { subject: "Hi", body: "Body" },
        },
        {
          id: "a1",
          type: "action.agent",
          position: { x: 2, y: 0 },
          data: { agentId: "agent-1" },
        },
      ],
      edges: [
        { id: "e-t-e", source: "t1", target: "e1" },
        { id: "e-e-a", source: "e1", target: "a1" },
      ],
    };

    const report = await runWorkflowTest({
      definition: def,
      testRecipients: {
        leadEmail: "lead@example.com",
        leadPhone: "+32470001122",
      },
      sendEmail: async () => ({ providerMessageId: "mail-1" }),
      sendSms: async () => ({ providerMessageId: "sms-1" }),
      handoffToAgent: async ({ lead }) => {
        channels.push(lead?.channel);
        return { handoff: "queued" };
      },
    });

    expect(report.status).toBe("success");
    expect(channels).toEqual(["EMAIL"]);
  });

  it("respects explicit handoff channel override", async () => {
    const channels: Array<"SMS" | "EMAIL" | undefined> = [];
    const def: WorkflowDefinition = {
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
        {
          id: "e1",
          type: "action.email",
          position: { x: 1, y: 0 },
          data: { subject: "Hi", body: "Body" },
        },
        {
          id: "a1",
          type: "action.agent",
          position: { x: 2, y: 0 },
          data: { agentId: "agent-1" },
        },
      ],
      edges: [
        { id: "e-t-e", source: "t1", target: "e1" },
        { id: "e-e-a", source: "e1", target: "a1" },
      ],
    };

    const report = await runWorkflowTest({
      definition: def,
      testRecipients: {
        leadEmail: "lead@example.com",
        leadPhone: "+32470001122",
        leadChannel: "SMS",
      },
      sendEmail: async () => ({ providerMessageId: "mail-1" }),
      sendSms: async () => ({ providerMessageId: "sms-1" }),
      handoffToAgent: async ({ lead }) => {
        channels.push(lead?.channel);
        return { handoff: "queued" };
      },
    });

    expect(report.status).toBe("success");
    expect(channels).toEqual(["SMS"]);
  });

  it("skips action modules outside send window", async () => {
    let emailCalls = 0;
    const def: WorkflowDefinition = {
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
        {
          id: "e1",
          type: "action.email",
          position: { x: 1, y: 0 },
          data: { to: "a@example.com", subject: "Hi", body: "Body" },
        },
      ],
      edges: [{ id: "e-t-e", source: "t1", target: "e1" }],
      settings: {
        sendWindow: {
          enabled: true,
          startTime: "09:00",
          endTime: "17:00",
          days: [9],
          timezone: "Europe/Brussels",
        },
      },
    };

    const report = await runWorkflowTest({
      definition: def,
      sendEmail: async () => {
        emailCalls += 1;
        return { providerMessageId: "mail-1" };
      },
      sendSms: async () => ({ providerMessageId: "sms-1" }),
    });

    expect(report.status).toBe("success");
    expect(emailCalls).toBe(0);
    expect(report.steps[1]?.output).toMatchObject({
      skipped: true,
    });
  });

  it("uses lead phone as sms recipient when 'to' is omitted", async () => {
    const sentTo: string[] = [];
    const def: WorkflowDefinition = {
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
        {
          id: "s1",
          type: "action.sms",
          position: { x: 1, y: 0 },
          data: { message: "Testbericht" },
        },
      ],
      edges: [{ id: "e-t-s", source: "t1", target: "s1" }],
    };

    const report = await runWorkflowTest({
      definition: def,
      testRecipients: { leadPhone: "+32470001122" },
      sendEmail: async () => ({ providerMessageId: "mail-1" }),
      sendSms: async ({ to }) => {
        sentTo.push(to);
        return { providerMessageId: "sms-1" };
      },
    });

    expect(report.status).toBe("success");
    expect(sentTo).toEqual(["+32470001122"]);
  });

  it("uses lead email as email recipient when 'to' is omitted", async () => {
    const sentTo: string[] = [];
    const def: WorkflowDefinition = {
      nodes: [
        { id: "t1", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
        {
          id: "e1",
          type: "action.email",
          position: { x: 1, y: 0 },
          data: { subject: "Test", body: "Body" },
        },
      ],
      edges: [{ id: "e-t-e", source: "t1", target: "e1" }],
    };

    const report = await runWorkflowTest({
      definition: def,
      testRecipients: { leadEmail: "lead@example.com" },
      sendEmail: async ({ to }) => {
        sentTo.push(to);
        return { providerMessageId: "mail-1" };
      },
      sendSms: async () => ({ providerMessageId: "sms-1" }),
    });

    expect(report.status).toBe("success");
    expect(sentTo).toEqual(["lead@example.com"]);
  });
});
