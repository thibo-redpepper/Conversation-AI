import crypto from "crypto";
import type { WorkflowDefinition, WorkflowNode } from "./types.js";
import { buildLinearChain } from "./validation.js";

export type WorkflowTestRecipients = {
  emailToOverride?: string;
  smsToOverride?: string;
  leadName?: string;
  leadEmail?: string;
  leadPhone?: string;
  leadContactId?: string;
  leadConversationId?: string;
  leadChannel?: "SMS" | "EMAIL";
  leadLastMessage?: string;
};

export type WorkflowExecutionStep = {
  nodeId: string;
  type: WorkflowNode["type"];
  status: "success" | "failed";
  output?: Record<string, unknown>;
};

export type WorkflowExecutionReport = {
  executionId: string;
  status: "success" | "failed";
  steps: WorkflowExecutionStep[];
  error?: { nodeId?: string; message: string };
};

export type SendEmailFn = (input: {
  to: string;
  subject: string;
  body: string;
}) => Promise<Record<string, unknown>>;

export type SendSmsFn = (input: { to: string; message: string }) => Promise<Record<string, unknown>>;

export type AgentHandoffFn = (input: {
  agentId: string;
  notes?: string;
  lead?: {
    name?: string;
    email?: string;
    phone?: string;
    contactId?: string;
    conversationId?: string;
    channel?: "SMS" | "EMAIL";
    lastMessage?: string;
  };
}) => Promise<Record<string, unknown>>;

const safeString = (value: unknown) => (typeof value === "string" ? value : "");

const LEAD_PHONE_TOKENS = new Set([
  "{{lead.phone}}",
  "{{ lead.phone }}",
  "{{lead_phone}}",
  "{{ lead_phone }}",
  "lead.phone",
  "lead_phone",
]);

const isLeadPhoneToken = (value: string) => LEAD_PHONE_TOKENS.has(value.trim().toLowerCase());

const LEAD_EMAIL_TOKENS = new Set([
  "{{lead.email}}",
  "{{ lead.email }}",
  "{{lead_email}}",
  "{{ lead_email }}",
  "lead.email",
  "lead_email",
]);

const isLeadEmailToken = (value: string) => LEAD_EMAIL_TOKENS.has(value.trim().toLowerCase());

const resolveEmailRecipient = (
  configuredTo: unknown,
  testRecipients?: WorkflowTestRecipients
) => {
  const rawTo = safeString(configuredTo).trim();
  if (!rawTo || isLeadEmailToken(rawTo)) {
    return safeString(testRecipients?.leadEmail).trim();
  }
  return rawTo;
};

const resolveSmsRecipient = (
  configuredTo: unknown,
  testRecipients?: WorkflowTestRecipients
) => {
  const rawTo = safeString(configuredTo).trim();
  if (!rawTo || isLeadPhoneToken(rawTo)) {
    return safeString(testRecipients?.leadPhone).trim();
  }
  return rawTo;
};

const hhmmToMinutes = (value: string) => {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const isWithinSendWindow = (
  sendWindow: {
    enabled?: boolean;
    startTime?: string;
    endTime?: string;
    days?: number[];
    timezone?: string;
  } | null | undefined
) => {
  if (!sendWindow?.enabled) return true;
  const timezone = sendWindow.timezone || "Europe/Brussels";
  const nowInZone = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: timezone,
    })
  );
  const day = nowInZone.getDay();
  const allowedDays = Array.isArray(sendWindow.days) ? sendWindow.days : [1, 2, 3, 4, 5];
  if (allowedDays.length > 0 && !allowedDays.includes(day)) {
    return false;
  }
  const startMinutes = hhmmToMinutes(sendWindow.startTime || "09:00");
  const endMinutes = hhmmToMinutes(sendWindow.endTime || "17:00");
  if (startMinutes === null || endMinutes === null) return true;

  const currentMinutes = nowInZone.getHours() * 60 + nowInZone.getMinutes();
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
};

const isActionNode = (type: WorkflowNode["type"]) =>
  type === "action.email" || type === "action.sms" || type === "action.agent";

const resolveLeadChannelForAgentHandoff = (input: {
  explicitChannel?: WorkflowTestRecipients["leadChannel"];
  lastDeliveryChannel?: "SMS" | "EMAIL";
  leadEmail?: string;
  leadPhone?: string;
}): "SMS" | "EMAIL" => {
  if (input.explicitChannel === "EMAIL") return "EMAIL";
  if (input.explicitChannel === "SMS") return "SMS";
  if (input.lastDeliveryChannel === "EMAIL") return "EMAIL";
  if (input.lastDeliveryChannel === "SMS") return "SMS";
  if (input.leadEmail && !input.leadPhone) return "EMAIL";
  return "SMS";
};

export const runWorkflowTest = async (args: {
  definition: WorkflowDefinition;
  testRecipients?: WorkflowTestRecipients;
  sendEmail: SendEmailFn;
  sendSms: SendSmsFn;
  handoffToAgent?: AgentHandoffFn;
  startNodeId?: string;
  pauseAtWait?: boolean;
  ignoreSendWindow?: boolean;
}): Promise<WorkflowExecutionReport> => {
  const executionId = crypto.randomUUID();
  const steps: WorkflowExecutionStep[] = [];

  const linear = buildLinearChain(args.definition);
  if ("message" in linear) {
    return {
      executionId,
      status: "failed",
      steps,
      error: { nodeId: linear.nodeId, message: linear.message },
    };
  }

  const chain = linear.chain;
  const sendWindow = args.definition.settings?.sendWindow;
  const startIndex = args.startNodeId
    ? chain.findIndex((node) => node.id === args.startNodeId)
    : 0;
  if (args.startNodeId && startIndex < 0) {
    return {
      executionId,
      status: "failed",
      steps,
      error: { message: `Start node niet gevonden in workflow: ${args.startNodeId}` },
    };
  }

  let lastDeliveryChannel: "SMS" | "EMAIL" | undefined =
    args.testRecipients?.leadChannel === "EMAIL"
      ? "EMAIL"
      : args.testRecipients?.leadChannel === "SMS"
        ? "SMS"
        : undefined;

  for (let index = Math.max(0, startIndex); index < chain.length; index += 1) {
    const node = chain[index]!;
    try {
      if (node.type === "trigger.manual" || node.type === "trigger.voicemail5") {
        steps.push({ nodeId: node.id, type: node.type, status: "success" });
        continue;
      }

      if (isActionNode(node.type) && !args.ignoreSendWindow && !isWithinSendWindow(sendWindow)) {
        steps.push({
          nodeId: node.id,
          type: node.type,
          status: "success",
          output: {
            skipped: true,
            reason: "Buiten ingesteld verzendvenster",
            sendWindow,
          },
        });
        continue;
      }

      if (node.type === "action.wait") {
        const amount = node.data["amount"];
        const unit = node.data["unit"];
        steps.push({
          nodeId: node.id,
          type: node.type,
          status: "success",
          output: args.pauseAtWait
            ? { amount, unit, paused: true, reason: "Wachtstap bereikt" }
            : { amount, unit },
        });
        if (args.pauseAtWait) {
          return { executionId, status: "success", steps };
        }
        continue;
      }

      if (node.type === "action.email") {
        const to =
          safeString(args.testRecipients?.emailToOverride).trim() ||
          resolveEmailRecipient(node.data["to"], args.testRecipients);
        if (!to) {
          throw new Error(
            "Email ontvanger ontbreekt. Vul 'to' in of geef een lead email mee."
          );
        }
        const subject = safeString(node.data["subject"]);
        const body = safeString(node.data["body"]);
        const output = await args.sendEmail({ to, subject, body });
        lastDeliveryChannel = "EMAIL";
        steps.push({ nodeId: node.id, type: node.type, status: "success", output: { to, ...output } });
        continue;
      }

      if (node.type === "action.sms") {
        const to =
          safeString(args.testRecipients?.smsToOverride).trim() ||
          resolveSmsRecipient(node.data["to"], args.testRecipients);
        if (!to) {
          throw new Error(
            "SMS ontvanger ontbreekt. Vul 'to' in of geef een lead telefoon mee."
          );
        }
        const message = safeString(node.data["message"]);
        const output = await args.sendSms({ to, message });
        lastDeliveryChannel = "SMS";
        steps.push({ nodeId: node.id, type: node.type, status: "success", output: { to, ...output } });
        continue;
      }

      if (node.type === "action.agent") {
        const agentId = safeString(node.data["agentId"]);
        if (!agentId) throw new Error("Agent: 'agentId' ontbreekt.");
        if (!args.handoffToAgent) throw new Error("Agent handoff functie ontbreekt.");
        const notes = safeString(node.data["notes"]) || undefined;
        const leadEmail = safeString(args.testRecipients?.leadEmail).trim() || undefined;
        const leadPhone = safeString(args.testRecipients?.leadPhone).trim() || undefined;
        const leadChannel = resolveLeadChannelForAgentHandoff({
          explicitChannel: args.testRecipients?.leadChannel,
          lastDeliveryChannel,
          leadEmail,
          leadPhone,
        });
        const output = await args.handoffToAgent({
          agentId,
          notes,
          lead: {
            name: safeString(args.testRecipients?.leadName) || undefined,
            email: leadEmail,
            phone: leadPhone,
            contactId:
              safeString(args.testRecipients?.leadContactId) || undefined,
            conversationId:
              safeString(args.testRecipients?.leadConversationId) || undefined,
            channel: leadChannel,
            lastMessage: safeString(args.testRecipients?.leadLastMessage) || undefined,
          },
        });
        steps.push({
          nodeId: node.id,
          type: node.type,
          status: "success",
          output: { agentId, ...output },
        });
        continue;
      }

      throw new Error(`Unsupported node type: ${String((node as { type?: unknown }).type)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Onbekende fout";
      steps.push({ nodeId: node.id, type: node.type, status: "failed" });
      return { executionId, status: "failed", steps, error: { nodeId: node.id, message } };
    }
  }

  return { executionId, status: "success", steps };
};
