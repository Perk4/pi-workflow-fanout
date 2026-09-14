import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inspectWorkflowScript } from "pi-extensible-workflows/validation";
import {
  buildFourStepWorkflow,
  fanoutFromWorkflowSource,
  validateFourStepPattern,
} from "../lib/fourStep.js";
import {
  CLAMP_COACH,
  DEFAULT_PATTERN_ID,
  PLAN_CRITIQUE,
  getPattern,
  listPatternIds,
  renderedWorkflowSource,
  workflowFileForPattern,
} from "../lib/patterns.js";
import { PINNED_WORKFLOW_ENGINE, runWorkflow } from "../run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function indexOf(trace, kind, name) {
  const i = trace.findIndex((step) => {
    if (step.kind !== kind) return false;
    if (name === undefined) return true;
    return step.label === name || step.name === name;
  });
  assert.notEqual(i, -1, `missing ${kind}${name ? ` ${name}` : ""}`);
  return i;
}

test("pattern ids are clamp-coach and plan-critique", () => {
  assert.deepEqual(listPatternIds(), ["clamp-coach", "plan-critique"]);
  assert.equal(getPattern().id, DEFAULT_PATTERN_ID);
  assert.equal(getPattern("plan-critique").parallelName, "plan-and-critique");
  assert.throws(() => getPattern("dual-review"), /Unknown workflow pattern/);
});

test("four-step builder validates arguments", () => {
  assert.throws(() => buildFourStepWorkflow(null), /must be an object/);
  assert.throws(
    () =>
      validateFourStepPattern({
        ...CLAMP_COACH,
        branches: { only: "one prompt" },
      }),
    /at least two fan-out labels/,
  );
  assert.throws(
    () =>
      validateFourStepPattern({
        ...CLAMP_COACH,
        branches: { "implement-vs-tests": "nope", tests: "nope" },
      }),
    /valid identifier/,
  );
  assert.throws(
    () => fanoutFromWorkflowSource(null),
    /requires source text/,
  );
});

test("committed workflow files match the four-step skeleton", async () => {
  for (const id of listPatternIds()) {
    const path = workflowFileForPattern(id, root);
    const committed = await readFile(path, "utf8");
    assert.equal(committed, renderedWorkflowSource(id));
  }
});

test("Clamp Coach remains implement+tests → gate → checkpoint → summary", async () => {
  const source = await readFile(join(root, "workflow.js"), "utf8");
  const calls = inspectWorkflowScript(source);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["parallel", "agent", "agent", "shell", "checkpoint", "agent"],
  );
  assert.equal(calls[0].name, "implement-and-test");
  assert.equal(calls[1].label, "implement");
  assert.equal(calls[2].label, "tests");
  assert.equal(calls[3].name, "node --test fixture/clamp.test.js");
  assert.deepEqual(fanoutFromWorkflowSource(source), {
    parallelName: "implement-and-test",
    labels: ["implement", "tests"],
  });
});

test("plan-critique is a second fan-out on the same skeleton", async () => {
  const source = await readFile(join(root, "workflows/plan-critique.js"), "utf8");
  const calls = inspectWorkflowScript(source);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["parallel", "agent", "agent", "shell", "checkpoint", "agent"],
  );
  assert.equal(calls[0].name, "plan-and-critique");
  assert.equal(calls[1].label, "plan");
  assert.equal(calls[2].label, "critique");
  assert.equal(calls[3].name, "node --check fixture/clamp.js");
  assert.equal(calls[4].name, "approve");
  assert.equal(calls[5].label, "summary");
  assert.notEqual(PLAN_CRITIQUE.gateCommand, CLAMP_COACH.gateCommand);
  assert.notDeepEqual(
    Object.keys(PLAN_CRITIQUE.branches),
    Object.keys(CLAMP_COACH.branches),
  );
});

test("order is plan+critique → gate → checkpoint → summary", async () => {
  const source = await readFile(join(root, "workflows/plan-critique.js"), "utf8");
  const { trace, value, engine } = await runWorkflow({
    source,
    cwd: root,
    decision: "approved",
    agent: "stub",
    systemPrompt: PLAN_CRITIQUE.systemPrompt,
  });

  const plan = indexOf(trace, "agent", "plan");
  const critique = indexOf(trace, "agent", "critique");
  const fanout = indexOf(trace, "parallel", "plan-and-critique");
  const gate = indexOf(trace, "shell");
  const checkpoint = indexOf(trace, "checkpoint", "approve");
  const summary = indexOf(trace, "agent", "summary");

  assert.ok(plan < gate, "plan runs before the gate");
  assert.ok(critique < gate, "critique runs before the gate");
  assert.ok(fanout < gate, "parallel finishes before the gate");
  assert.ok(gate < checkpoint, "gate runs before checkpoint");
  assert.ok(checkpoint < summary, "checkpoint runs before summary");
  assert.equal(trace[gate].exitCode, 0);
  assert.equal(value.ok, true);
  assert.match(String(value.fanout.plan), /stub:plan/);
  assert.match(String(value.fanout.critique), /stub:critique/);
  assert.match(String(value.summary), /stub:summary/);
  assert.equal(engine, PINNED_WORKFLOW_ENGINE);
});

test("plan-critique rejected checkpoint skips summary", async () => {
  const source = await readFile(join(root, "workflows/plan-critique.js"), "utf8");
  const { trace, value } = await runWorkflow({
    source,
    cwd: root,
    decision: "rejected",
    agent: "stub",
  });

  assert.equal(value.ok, false);
  assert.equal(value.stage, "checkpoint");
  indexOf(trace, "parallel", "plan-and-critique");
  assert.equal(
    trace.filter((step) => step.kind === "agent" && step.label === "summary")
      .length,
    0,
  );
});

test("CLI --pattern plan-critique runs the second fan-out", () => {
  const result = spawnSync(
    process.execPath,
    ["run.js", "--stub", "--pattern", "plan-critique"],
    { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.value.ok, true);
  assert.match(String(parsed.value.fanout.plan), /stub:plan/);
  assert.match(String(parsed.value.fanout.critique), /stub:critique/);
  assert.equal(parsed.engine, PINNED_WORKFLOW_ENGINE);
});

test("CLI unknown --pattern fails closed", () => {
  const result = spawnSync(
    process.execPath,
    ["run.js", "--stub", "--pattern", "not-a-pattern"],
    { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown workflow pattern/);
});

test("plan-critique live path uses the pattern system prompt", async () => {
  const source = buildFourStepWorkflow(PLAN_CRITIQUE);
  const requests = [];
  const { value } = await runWorkflow({
    source,
    cwd: root,
    decision: "approved",
    agent: "live",
    systemPrompt: PLAN_CRITIQUE.systemPrompt,
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
    assert.equal(JSON.parse(request.init.body).messages[0].content, PLAN_CRITIQUE.systemPrompt);
  }
  assert.match(value.fanout.plan, /^ok:\d+$/);
  assert.match(value.fanout.critique, /^ok:\d+$/);
  assert.equal(value.ok, true);
});
