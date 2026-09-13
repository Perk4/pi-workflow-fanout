// Clamp Coach: one named Pi coach use-case on the four-step graph.
// Sandboxed JS: no imports. Globals are injected by pi-extensible-workflows.

// 1. Fan out two agents: implement vs write tests.
const fanout = await parallel("implement-and-test", {
  implement: () =>
    agent("Implement clamp(value, min, max) in fixture/clamp.js.", {
      label: "implement",
    }),
  tests: () =>
    agent("Write tests for clamp in fixture/clamp.test.js.", {
      label: "tests",
    }),
});

// 2. Deterministic test command as the gate.
const gate = await shell("node --test fixture/clamp.test.js");
if (gate.exitCode !== 0) {
  return { ok: false, stage: "gate", fanout, gate };
}

// 3. Checkpoint: pause for human approve / reject.
const decision = await checkpoint({
  name: "approve",
  prompt: "Tests passed. Approve the Clamp Coach fan-out?",
  context: { fanout, exitCode: gate.exitCode },
});
if (decision !== "approved") {
  return { ok: false, stage: "checkpoint", fanout, decision };
}

// 4. Summary agent.
const summary = await agent(
  prompt("Summarize implement, tests, and the gate.\n{fanout}\nexitCode={exitCode}", {
    fanout,
    exitCode: gate.exitCode,
  }),
  { label: "summary" },
);

return { ok: true, fanout, gate: { exitCode: gate.exitCode }, decision, summary };
