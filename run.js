import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function runWorkflow({ source, cwd, decision = "approved" }) {
  const trace = [];

  async function agent(promptText, options = {}) {
    const label = options.label ?? "agent";
    trace.push({ kind: "agent", label });
    return `[stub:${label}] ${String(promptText)}`;
  }

  async function shell(command) {
    const result = spawnSync(command, {
      shell: true,
      encoding: "utf8",
      cwd,
      env: process.env,
    });
    const exitCode = result.status ?? 1;
    trace.push({ kind: "shell", command, exitCode });
    return {
      exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  async function parallel(name, tasks) {
    const keys = Object.keys(tasks);
    const pairs = await Promise.all(
      keys.map(async (key) => [key, await tasks[key]()]),
    );
    trace.push({ kind: "parallel", name });
    return Object.fromEntries(pairs);
  }

  async function checkpoint(input) {
    trace.push({ kind: "checkpoint", name: input.name, decision });
    return decision;
  }

  function prompt(template, values) {
    return template.replace(/\{(\w+)\}/g, (_, key) =>
      JSON.stringify(values[key], null, 2),
    );
  }

  const run = new AsyncFunction(
    "agent",
    "shell",
    "parallel",
    "checkpoint",
    "prompt",
    `"use strict";\n${source}`,
  );
  const value = await run(agent, shell, parallel, checkpoint, prompt);
  return { value, trace };
}

async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(join(root, "workflow.js"), "utf8");
  const decision = process.argv.includes("--reject") ? "rejected" : "approved";
  return runWorkflow({ source, cwd: root, decision });
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await main();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.value?.ok === false ? 1 : 0);
}
