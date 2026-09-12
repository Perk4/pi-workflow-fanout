import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inspectWorkflowScript } from "pi-extensible-workflows/validation";
import {
  PINNED_WORKFLOW_ENGINE,
  credentialsFromEnv,
  loadPinnedWorkflowEngine,
  pinnedWorkflowEngineUrl,
  runWorkflow,
} from "../run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "workflow.js"), "utf8");

function indexOf(trace, kind, name) {
  const i = trace.findIndex((step) => {
    if (step.kind !== kind) return false;
    if (name === undefined) return true;
    return step.label === name || step.name === name;
  });
  assert.notEqual(i, -1, `missing ${kind}${name ? ` ${name}` : ""}`);
  return i;
}

test("pinned engine is pi-extensible-workflows@5.14.0", async () => {
  assert.equal(PINNED_WORKFLOW_ENGINE, "pi-extensible-workflows@5.14.0");
  assert.match(pinnedWorkflowEngineUrl(), /pi-extensible-workflows\/dist\/src\/execution\.js$/);
  const engine = await loadPinnedWorkflowEngine();
  assert.equal(typeof engine.runWorkflow, "function");
  assert.equal(typeof engine.executeShellCommand, "function");
});

test("Clamp Coach script is implement+tests → gate → checkpoint → summary", () => {
  const calls = inspectWorkflowScript(source);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["parallel", "agent", "agent", "shell", "checkpoint", "agent"],
  );
  assert.equal(calls[0].name, "implement-and-test");
  assert.equal(calls[1].label, "implement");
  assert.equal(calls[2].label, "tests");
  assert.equal(calls[3].name, "node --test fixture/clamp.test.js");
  assert.equal(calls[4].name, "approve");
  assert.equal(calls[5].label, "summary");
});

test("order is implement+tests → gate → checkpoint → summary", async () => {
  const { trace, value, engine } = await runWorkflow({
    source,
    cwd: root,
    decision: "approved",
    agent: "stub",
  });

  const implement = indexOf(trace, "agent", "implement");
  const tests = indexOf(trace, "agent", "tests");
  const fanout = indexOf(trace, "parallel", "implement-and-test");
  const gate = indexOf(trace, "shell");
  const checkpoint = indexOf(trace, "checkpoint", "approve");
  const summary = indexOf(trace, "agent", "summary");

  assert.ok(implement < gate, "implement runs before the gate");
  assert.ok(tests < gate, "tests run before the gate");
  assert.ok(fanout < gate, "parallel finishes before the gate");
  assert.ok(gate < checkpoint, "gate runs before checkpoint");
  assert.ok(checkpoint < summary, "checkpoint runs before summary");
  assert.equal(trace[gate].exitCode, 0);
  assert.equal(value.ok, true);
  assert.equal(engine, PINNED_WORKFLOW_ENGINE);
  assert.match(String(value.summary), /stub:summary/);
});

test("rejected checkpoint skips summary", async () => {
  const { trace, value } = await runWorkflow({
    source,
    cwd: root,
    decision: "rejected",
    agent: "stub",
  });

  assert.equal(value.ok, false);
  assert.equal(value.stage, "checkpoint");
  indexOf(trace, "shell");
  indexOf(trace, "checkpoint", "approve");
  assert.equal(
    trace.filter((step) => step.kind === "agent" && step.label === "summary")
      .length,
    0,
  );
});

test("gate fails closed on non-zero exit and skips checkpoint", async () => {
  const failing = `
const gate = await shell("node --eval process.exit(2)");
if (gate.exitCode !== 0) {
  return { ok: false, stage: "gate", gate };
}
await checkpoint({ name: "approve", prompt: "should not run", context: {} });
return { ok: true };
`;
  const { trace, value } = await runWorkflow({
    source: failing,
    cwd: root,
    decision: "approved",
    agent: "stub",
  });

  assert.equal(value.ok, false);
  assert.equal(value.stage, "gate");
  assert.notEqual(value.gate.exitCode, 0);
  assert.equal(trace.some((step) => step.kind === "checkpoint"), false);
});

test("real worker sandbox blocks Date.now", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        source: "return Date.now();",
        cwd: root,
        decision: "approved",
        agent: "stub",
      }),
    /now/,
  );
});

test("live implement+tests fan-out uses the injected LLM path", async () => {
  const labels = [];
  const { trace, value } = await runWorkflow({
    source,
    cwd: root,
    decision: "approved",
    agent: "live",
    completeAgent: async (promptText, options) => {
      labels.push(options.label);
      return `live:${options.label}:${String(promptText).slice(0, 24)}`;
    },
  });

  assert.deepEqual(labels.sort(), ["implement", "summary", "tests"]);
  assert.match(value.fanout.implement, /^live:implement:/);
  assert.match(value.fanout.tests, /^live:tests:/);
  assert.match(String(value.summary), /^live:summary:/);
  assert.equal(value.ok, true);
  indexOf(trace, "agent", "implement");
  indexOf(trace, "agent", "tests");
});

test("live path without credentials fails closed", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        source,
        cwd: root,
        decision: "approved",
        agent: "live",
        env: {},
      }),
    /OPENAI_API_KEY/,
  );
});

test("live OpenAI-compatible completions use env credentials", async () => {
  const requests = [];
  const { value } = await runWorkflow({
    source,
    cwd: root,
    decision: "approved",
    agent: "live",
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://example.test/v1",
      PI_COACH_MODEL: "test-model",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { content: `ok:${requests.length}` } }],
          });
        },
      };
    },
  });

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.url, "https://example.test/v1/chat/completions");
    assert.equal(request.init.headers.authorization, "Bearer test-key");
    assert.equal(JSON.parse(request.init.body).model, "test-model");
  }
  assert.match(value.fanout.implement, /^ok:\d+$/);
  assert.match(value.fanout.tests, /^ok:\d+$/);
  assert.match(String(value.summary), /^ok:\d+$/);
  assert.equal(value.ok, true);
});

test("credentialsFromEnv prefers explicit PI_COACH_API_KEY", () => {
  const creds = credentialsFromEnv({
    PI_COACH_API_KEY: "perk-key",
    PI_COACH_BASE_URL: "https://relay.example/v1",
    PI_COACH_MODEL: "coach-model",
  });
  assert.deepEqual(creds, {
    kind: "openai",
    apiKey: "perk-key",
    baseUrl: "https://relay.example/v1",
    model: "coach-model",
  });
});

test("importing run.js without file argv does not throw", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", "import('./run.js')"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("CLI --live without credentials fails closed", () => {
  const result = spawnSync(process.execPath, ["run.js", "--live"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPENAI_API_KEY/);
});

test("CLI stub path still auto-approves on non-TTY", () => {
  const result = spawnSync(process.execPath, ["run.js", "--stub"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.value.ok, true);
  assert.equal(parsed.engine, PINNED_WORKFLOW_ENGINE);
});
