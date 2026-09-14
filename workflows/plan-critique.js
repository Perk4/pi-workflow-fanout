// Plan vs critique: second fan-out on the four-step skeleton.
// Pattern-specific composition of the reusable four-step skeleton (lib/fourStep.js).
// Sandboxed JS: no imports. Globals are injected by pi-extensible-workflows.

// 1. Fan out two agents: plan vs critique.
const fanout = await parallel("plan-and-critique", {
  plan: () =>
    agent("Propose a short plan for clamp(value, min, max) in fixture/clamp.js.", {
      label: "plan",
    }),
  critique: () =>
    agent("Critique the current clamp implementation in fixture/clamp.js.", {
      label: "critique",
    }),
});

// 2. Deterministic syntax check as the gate.
const gate = await shell("node --check fixture/clamp.js");
if (gate.exitCode !== 0) {
  return { ok: false, stage: "gate", fanout, gate };
}

// 3. Checkpoint: pause for human approve / reject.
const decision = await checkpoint({
  name: "approve",
  prompt: "Plan and critique returned. Approve this fan-out?",
  context: { fanout, exitCode: gate.exitCode },
});
if (decision !== "approved") {
  return { ok: false, stage: "checkpoint", fanout, decision };
}

// 4. Summary agent.
const summary = await agent(
  prompt("Summarize plan, critique, and the gate.\n{fanout}\nexitCode={exitCode}", {
    fanout,
    exitCode: gate.exitCode,
  }),
  { label: "summary" },
);

return { ok: true, fanout, gate: { exitCode: gate.exitCode }, decision, summary };
