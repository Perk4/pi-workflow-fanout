import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runWorkflow } from "../run.js";

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

test("order is implement+tests → gate → checkpoint → summary", async () => {
  const { trace, value } = await runWorkflow({
    source,
    cwd: root,
    decision: "approved",
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
});

test("rejected checkpoint skips summary", async () => {
  const { trace, value } = await runWorkflow({
    source,
    cwd: root,
    decision: "rejected",
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

test("importing run.js without file argv does not throw", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", "import('./run.js')"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});
