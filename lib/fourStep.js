// Reusable four-step skeleton for sandboxed Pi workflow scripts.
// Those scripts cannot import, so this Node helper emits the graph:
// fan-out → gate → checkpoint → summary.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateFourStepPattern(pattern) {
  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) {
    throw new Error("four-step pattern must be an object");
  }

  const {
    id,
    header,
    parallelName,
    branches,
    gateCommand,
    checkpoint,
    summaryPrompt,
    fanoutLead,
    gateLead,
  } = pattern;

  if (typeof id !== "string" || !id.trim()) {
    throw new Error("pattern.id must be a nonempty string");
  }
  if (typeof header !== "string" || !header.trim()) {
    throw new Error("pattern.header must be a nonempty string");
  }
  if (typeof parallelName !== "string" || !parallelName.trim()) {
    throw new Error("pattern.parallelName must be a nonempty string");
  }
  if (!branches || typeof branches !== "object" || Array.isArray(branches)) {
    throw new Error("pattern.branches must be an object of label → prompt");
  }

  const labels = Object.keys(branches);
  if (labels.length < 2) {
    throw new Error("pattern.branches needs at least two fan-out labels");
  }
  for (const label of labels) {
    if (!IDENT.test(label)) {
      throw new Error(`pattern.branches label "${label}" is not a valid identifier`);
    }
    if (typeof branches[label] !== "string" || !branches[label].trim()) {
      throw new Error(`pattern.branches.${label} must be a nonempty prompt string`);
    }
  }

  if (typeof gateCommand !== "string" || !gateCommand.trim()) {
    throw new Error("pattern.gateCommand must be a nonempty string");
  }
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error("pattern.checkpoint must be an object");
  }
  if (typeof checkpoint.name !== "string" || !checkpoint.name.trim()) {
    throw new Error("pattern.checkpoint.name must be a nonempty string");
  }
  if (typeof checkpoint.prompt !== "string" || !checkpoint.prompt.trim()) {
    throw new Error("pattern.checkpoint.prompt must be a nonempty string");
  }
  if (typeof summaryPrompt !== "string" || !summaryPrompt.trim()) {
    throw new Error("pattern.summaryPrompt must be a nonempty string");
  }
  if (fanoutLead !== undefined && (typeof fanoutLead !== "string" || !fanoutLead.trim())) {
    throw new Error("pattern.fanoutLead must be a nonempty string when set");
  }
  if (gateLead !== undefined && (typeof gateLead !== "string" || !gateLead.trim())) {
    throw new Error("pattern.gateLead must be a nonempty string when set");
  }

  return pattern;
}

export function buildFourStepWorkflow(pattern) {
  const valid = validateFourStepPattern(pattern);
  const labels = Object.keys(valid.branches);
  const vs = labels.join(" vs ");
  const fanoutLead =
    valid.fanoutLead ?? `Fan out ${labels.length} agents: ${vs}.`;
  const gateLead = valid.gateLead ?? "Deterministic command as the gate.";
  const branchSource = labels
    .map(
      (label) => `  ${label}: () =>
    agent(${jsString(valid.branches[label])}, {
      label: ${jsString(label)},
    }),`,
    )
    .join("\n");

  return `${valid.header.trimEnd()}

// 1. ${fanoutLead}
const fanout = await parallel(${jsString(valid.parallelName)}, {
${branchSource}
});

// 2. ${gateLead}
const gate = await shell(${jsString(valid.gateCommand)});
if (gate.exitCode !== 0) {
  return { ok: false, stage: "gate", fanout, gate };
}

// 3. Checkpoint: pause for human approve / reject.
const decision = await checkpoint({
  name: ${jsString(valid.checkpoint.name)},
  prompt: ${jsString(valid.checkpoint.prompt)},
  context: { fanout, exitCode: gate.exitCode },
});
if (decision !== "approved") {
  return { ok: false, stage: "checkpoint", fanout, decision };
}

// 4. Summary agent.
const summary = await agent(
  prompt(${jsString(valid.summaryPrompt)}, {
    fanout,
    exitCode: gate.exitCode,
  }),
  { label: "summary" },
);

return { ok: true, fanout, gate: { exitCode: gate.exitCode }, decision, summary };
`;
}

export function fanoutFromWorkflowSource(source) {
  if (typeof source !== "string") {
    throw new Error("fanoutFromWorkflowSource requires source text");
  }

  const parallel = source.match(/await\s+parallel\(\s*(['"])([^'"]+)\1/);
  if (!parallel) return null;

  const labels = [];
  const labelRe = /label:\s*(['"])([^'"]+)\1/g;
  let match = labelRe.exec(source);
  while (match) {
    if (match[2] !== "summary") labels.push(match[2]);
    match = labelRe.exec(source);
  }
  const unique = [...new Set(labels)];
  if (unique.length < 2) return null;
  return { parallelName: parallel[2], labels: unique };
}

function jsString(value) {
  return JSON.stringify(value);
}
