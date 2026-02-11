import type { WorkflowDefinition, WorkflowNode, WorkflowNodeType } from "./types.js";

export type WorkflowValidationError = {
  message: string;
  nodeId?: string;
};

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0;

const positiveInt = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isWaitUnit = (value: unknown) =>
  value === "minutes" || value === "hours" || value === "days";

const isTriggerType = (type: unknown) =>
  type === "trigger.manual" || type === "trigger.voicemail5";

const validateNodeConfig = (node: WorkflowNode): WorkflowValidationError | null => {
  const data = node.data ?? {};
  if (isTriggerType(node.type)) return null;

  if (node.type === "action.email") {
    if (!nonEmptyString(data["subject"]))
      return { nodeId: node.id, message: "Email: 'subject' ontbreekt." };
    if (!nonEmptyString(data["body"]))
      return { nodeId: node.id, message: "Email: 'body' ontbreekt." };
    return null;
  }

  if (node.type === "action.sms") {
    if (!nonEmptyString(data["message"]))
      return { nodeId: node.id, message: "SMS: 'message' ontbreekt." };
    return null;
  }

  if (node.type === "action.wait") {
    if (!positiveInt(data["amount"]))
      return { nodeId: node.id, message: "Wacht: 'amount' moet een positief geheel getal zijn." };
    if (!isWaitUnit(data["unit"]))
      return { nodeId: node.id, message: "Wacht: 'unit' moet minutes/hours/days zijn." };
    return null;
  }

  if (node.type === "action.agent") {
    if (!nonEmptyString(data["agentId"]))
      return { nodeId: node.id, message: "Agent: 'agentId' ontbreekt." };
    return null;
  }

  // Exhaustiveness guard (if types drift at runtime).
  return { nodeId: node.id, message: `Onbekend node type: ${(node as { type?: unknown }).type}` };
};

export const buildLinearChain = (
  definition: WorkflowDefinition
): { trigger: WorkflowNode; chain: WorkflowNode[] } | WorkflowValidationError => {
  const nodes = definition.nodes ?? [];
  const edges = definition.edges ?? [];

  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return { message: "Definition moet nodes + edges bevatten." };
  }

  const byId = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (!node?.id || typeof node.id !== "string") {
      return { message: "Elke node moet een geldige 'id' hebben." };
    }
    if (byId.has(node.id)) {
      return { nodeId: node.id, message: "Node id moet uniek zijn." };
    }
    byId.set(node.id, node);
  }

  const triggers = nodes.filter((n) => isTriggerType(n.type));
  if (triggers.length !== 1) {
    return { message: "Workflow moet exact 1 trigger hebben (trigger.manual of trigger.voicemail5)." };
  }
  const trigger = triggers[0]!;

  const outgoing = new Map<string, string>();
  const incomingCount = new Map<string, number>();

  for (const node of nodes) {
    incomingCount.set(node.id, 0);
  }

  for (const edge of edges) {
    if (!edge?.source || !edge?.target) {
      return { message: "Elke edge moet 'source' en 'target' hebben." };
    }
    const source = String(edge.source);
    const target = String(edge.target);
    if (!byId.has(source)) return { nodeId: source, message: "Edge source node bestaat niet." };
    if (!byId.has(target)) return { nodeId: target, message: "Edge target node bestaat niet." };

    if (outgoing.has(source)) {
      return { nodeId: source, message: "Elke node mag max 1 outgoing edge hebben." };
    }
    outgoing.set(source, target);
    incomingCount.set(target, (incomingCount.get(target) ?? 0) + 1);
  }

  for (const node of nodes) {
    const inc = incomingCount.get(node.id) ?? 0;
    if (node.id === trigger.id) {
      if (inc !== 0) return { nodeId: node.id, message: "Trigger mag geen incoming edges hebben." };
      continue;
    }
    if (inc !== 1) {
      return {
        nodeId: node.id,
        message: "Elke niet-trigger node moet exact 1 incoming edge hebben.",
      };
    }
  }

  const visited = new Set<string>();
  const chain: WorkflowNode[] = [];
  let currentId: string | undefined = trigger.id;

  while (currentId) {
    if (visited.has(currentId)) {
      return { nodeId: currentId, message: "Cycle gedetecteerd in workflow." };
    }
    visited.add(currentId);
    const node = byId.get(currentId);
    if (!node) break;
    chain.push(node);
    currentId = outgoing.get(currentId);
  }

  if (visited.size !== nodes.length) {
    const unreachable = nodes.find((n) => !visited.has(n.id));
    return {
      nodeId: unreachable?.id,
      message: "Workflow is niet lineair of bevat niet-bereikbare nodes.",
    };
  }

  for (const node of chain) {
    const error = validateNodeConfig(node);
    if (error) return error;
  }

  // Ensure trigger node type is correct (defensive).
  if (!isTriggerType(trigger.type as WorkflowNodeType)) {
    return { nodeId: trigger.id, message: "Trigger type is ongeldig." };
  }

  return { trigger, chain };
};
