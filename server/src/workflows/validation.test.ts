import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "./types.js";
import { buildLinearChain } from "./validation.js";

const baseTrigger = () => ({
  id: "t1",
  type: "trigger.manual" as const,
  position: { x: 0, y: 0 },
  data: {},
});

describe("buildLinearChain", () => {
  it("accepts trigger-only workflow", () => {
    const def: WorkflowDefinition = { nodes: [baseTrigger()], edges: [] };
    const result = buildLinearChain(def);
    expect("message" in result).toBe(false);
    if ("message" in result) return;
    expect(result.chain.map((n) => n.id)).toEqual(["t1"]);
  });

  it("rejects multiple triggers", () => {
    const def: WorkflowDefinition = {
      nodes: [baseTrigger(), { ...baseTrigger(), id: "t2" }],
      edges: [],
    };
    const result = buildLinearChain(def);
    expect("message" in result).toBe(true);
  });

  it("rejects branching outgoing edges", () => {
    const def: WorkflowDefinition = {
      nodes: [
        baseTrigger(),
        { id: "a1", type: "action.wait", position: { x: 1, y: 0 }, data: { amount: 1, unit: "hours" } },
        { id: "a2", type: "action.wait", position: { x: 2, y: 0 }, data: { amount: 1, unit: "hours" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "t1", target: "a2" },
      ],
    };
    const result = buildLinearChain(def);
    expect("message" in result).toBe(true);
  });

  it("rejects unreachable nodes", () => {
    const def: WorkflowDefinition = {
      nodes: [
        baseTrigger(),
        { id: "a1", type: "action.wait", position: { x: 1, y: 0 }, data: { amount: 1, unit: "hours" } },
        { id: "a2", type: "action.wait", position: { x: 2, y: 0 }, data: { amount: 1, unit: "hours" } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = buildLinearChain(def);
    expect("message" in result).toBe(true);
  });

  it("rejects cycles", () => {
    const def: WorkflowDefinition = {
      nodes: [
        baseTrigger(),
        { id: "a1", type: "action.wait", position: { x: 1, y: 0 }, data: { amount: 1, unit: "hours" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "t1" },
      ],
    };
    const result = buildLinearChain(def);
    expect("message" in result).toBe(true);
  });

  it("rejects missing required email fields", () => {
    const def: WorkflowDefinition = {
      nodes: [
        baseTrigger(),
        { id: "e1", type: "action.email", position: { x: 1, y: 0 }, data: { to: "", subject: "", body: "" } },
      ],
      edges: [{ id: "edge", source: "t1", target: "e1" }],
    };
    const result = buildLinearChain(def);
    expect("message" in result).toBe(true);
  });

  it("rejects agent node without agentId", () => {
    const def: WorkflowDefinition = {
      nodes: [
        baseTrigger(),
        { id: "a1", type: "action.agent", position: { x: 1, y: 0 }, data: { notes: "Follow-up" } },
      ],
      edges: [{ id: "edge", source: "t1", target: "a1" }],
    };
    const result = buildLinearChain(def);
    expect("message" in result).toBe(true);
  });

  it("accepts sms node without explicit 'to' recipient", () => {
    const def: WorkflowDefinition = {
      nodes: [
        baseTrigger(),
        { id: "s1", type: "action.sms", position: { x: 1, y: 0 }, data: { message: "Hallo" } },
      ],
      edges: [{ id: "edge", source: "t1", target: "s1" }],
    };
    const result = buildLinearChain(def);
    expect("message" in result).toBe(false);
  });

  it("accepts email node without explicit 'to' recipient", () => {
    const def: WorkflowDefinition = {
      nodes: [
        baseTrigger(),
        {
          id: "e1",
          type: "action.email",
          position: { x: 1, y: 0 },
          data: { subject: "Hallo", body: "Body" },
        },
      ],
      edges: [{ id: "edge", source: "t1", target: "e1" }],
    };
    const result = buildLinearChain(def);
    expect("message" in result).toBe(false);
  });
});
