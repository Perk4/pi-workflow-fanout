import { join } from "node:path";
import { buildFourStepWorkflow, validateFourStepPattern } from "./fourStep.js";

export const DEFAULT_PATTERN_ID = "clamp-coach";

export const CLAMP_COACH = validateFourStepPattern({
  id: DEFAULT_PATTERN_ID,
  title: "Clamp Coach",
  header: `// Clamp Coach: one named Pi coach use-case on the four-step graph.
// Coach-specific composition of the reusable four-step skeleton (lib/fourStep.js).
// Sandboxed JS: no imports. Globals are injected by pi-extensible-workflows.`,
  parallelName: "implement-and-test",
  branches: {
    implement: "Implement clamp(value, min, max) in fixture/clamp.js.",
    tests: "Write tests for clamp in fixture/clamp.test.js.",
  },
  fanoutLead: "Fan out two agents: implement vs write tests.",
  gateLead: "Deterministic test command as the gate.",
  gateCommand: "node --test fixture/clamp.test.js",
  checkpoint: {
    name: "approve",
    prompt: "Tests passed. Approve the Clamp Coach fan-out?",
  },
  summaryPrompt:
    "Summarize implement, tests, and the gate.\n{fanout}\nexitCode={exitCode}",
  systemPrompt:
    "You are Clamp Coach, a Pi workflow coach. Answer the implement, tests, or summary step in plain text.",
});

export const PLAN_CRITIQUE = validateFourStepPattern({
  id: "plan-critique",
  title: "Plan vs critique",
  header: `// Plan vs critique: second fan-out on the four-step skeleton.
// Pattern-specific composition of the reusable four-step skeleton (lib/fourStep.js).
// Sandboxed JS: no imports. Globals are injected by pi-extensible-workflows.`,
  parallelName: "plan-and-critique",
  branches: {
    plan: "Propose a short plan for clamp(value, min, max) in fixture/clamp.js.",
    critique: "Critique the current clamp implementation in fixture/clamp.js.",
  },
  fanoutLead: "Fan out two agents: plan vs critique.",
  gateLead: "Deterministic syntax check as the gate.",
  gateCommand: "node --check fixture/clamp.js",
  checkpoint: {
    name: "approve",
    prompt: "Plan and critique returned. Approve this fan-out?",
  },
  summaryPrompt:
    "Summarize plan, critique, and the gate.\n{fanout}\nexitCode={exitCode}",
  systemPrompt:
    "You are a Pi workflow agent. Answer the plan, critique, or summary step in plain text.",
});

export const PATTERNS = {
  [CLAMP_COACH.id]: CLAMP_COACH,
  [PLAN_CRITIQUE.id]: PLAN_CRITIQUE,
};

export function listPatternIds() {
  return Object.keys(PATTERNS);
}

export function getPattern(id = DEFAULT_PATTERN_ID) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("pattern id must be a nonempty string");
  }
  const pattern = PATTERNS[id];
  if (!pattern) {
    throw new Error(
      `Unknown workflow pattern "${id}". Use ${listPatternIds().join(" or ")}.`,
    );
  }
  return pattern;
}

export function workflowFileForPattern(patternId, root) {
  if (typeof root !== "string" || !root) {
    throw new Error("workflowFileForPattern requires a directory");
  }
  const pattern = getPattern(patternId);
  if (pattern.id === DEFAULT_PATTERN_ID) return join(root, "workflow.js");
  return join(root, "workflows", `${pattern.id}.js`);
}

export function renderedWorkflowSource(patternId) {
  return buildFourStepWorkflow(getPattern(patternId));
}
