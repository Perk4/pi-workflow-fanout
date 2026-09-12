import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PINNED_WORKFLOW_ENGINE = "pi-extensible-workflows@5.14.0";
export const REQUIRED_LIVE_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "PI_COACH_API_KEY",
];
const LIVE_TIMEOUT_MS = 60_000;

let enginePromise;

// The package root export is a Pi TUI extension and needs a matching Pi coding-agent
// host. Headless `piewf run` cannot execute checkpointed workflows. The sandboxed
// worker in dist/src/execution.js is the same agent/shell/checkpoint/parallel runtime.
export function pinnedWorkflowEngineUrl() {
  return new URL("./execution.js", import.meta.resolve("pi-extensible-workflows")).href;
}

export async function loadPinnedWorkflowEngine() {
  enginePromise ??= import(pinnedWorkflowEngineUrl());
  return enginePromise;
}

export function parseEnvFile(text) {
  const parsed = {};
  if (typeof text !== "string") return parsed;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key || value === "") continue;
    parsed[key] = value;
  }
  return parsed;
}

export function applyEnvFile(env, parsed) {
  if (!env || typeof env !== "object") {
    throw new Error("applyEnvFile requires an env object");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("applyEnvFile requires parsed env values");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
  return env;
}

export async function loadLocalEnvFile(root, env = process.env) {
  if (typeof root !== "string" || !root) {
    throw new Error("loadLocalEnvFile requires a directory");
  }
  try {
    const text = await readFile(join(root, ".env.local"), "utf8");
    return applyEnvFile(env, parseEnvFile(text));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return env;
    throw error;
  }
}

export function credentialsFromEnv(env = process.env) {
  const apiKey =
    env.PI_COACH_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || "";
  if (!apiKey) return null;

  if (preferAnthropic(env)) {
    return {
      kind: "anthropic",
      apiKey: env.PI_COACH_API_KEY || env.ANTHROPIC_API_KEY,
      baseUrl: trimSlash(
        env.PI_COACH_BASE_URL || env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      ),
      model: env.PI_COACH_MODEL || env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    };
  }

  return {
    kind: "openai",
    apiKey,
    baseUrl: trimSlash(
      env.PI_COACH_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    ),
    model: env.PI_COACH_MODEL || env.OPENAI_MODEL || "gpt-4.1-mini",
  };
}

function preferAnthropic(env) {
  if (env.PI_COACH_PROVIDER === "anthropic") return true;
  if (env.PI_COACH_PROVIDER === "openai") return false;
  if (env.OPENAI_API_KEY) return false;
  const model = env.PI_COACH_MODEL || env.ANTHROPIC_MODEL || "";
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL) || model.startsWith("claude");
}

export async function runWorkflow({
  source,
  cwd,
  decision,
  agent = "stub",
  completeAgent,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stderr,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof source !== "string") {
    throw new Error("runWorkflow requires workflow source text");
  }
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("runWorkflow requires a cwd");
  }
  if (agent !== "stub" && agent !== "live") {
    throw new Error('runWorkflow agent must be "stub" or "live"');
  }
  if (decision !== undefined && decision !== "approved" && decision !== "rejected") {
    throw new Error('runWorkflow decision must be "approved" or "rejected"');
  }

  const engine = await loadPinnedWorkflowEngine();
  const credentials = credentialsFromEnv(env);
  if (agent === "live" && typeof completeAgent !== "function" && !credentials) {
    throw new Error(
      "Clamp Coach live path needs OPENAI_API_KEY, ANTHROPIC_API_KEY, or PI_COACH_API_KEY",
    );
  }

  const liveComplete =
    typeof completeAgent === "function"
      ? completeAgent
      : credentials
        ? (promptText, options, signal) =>
            completeLiveAgent(promptText, options, {
              credentials,
              fetchImpl,
              signal,
            })
        : null;

  const trace = [];
  const execution = engine.runWorkflow(source, null, {
    async agent(promptText, options, signal) {
      const label =
        typeof options.label === "string" && options.label ? options.label : "agent";
      trace.push({ kind: "agent", label });
      if (agent === "live") {
        return await liveComplete(String(promptText), options, signal);
      }
      return `[stub:${label}] ${String(promptText)}`;
    },
    async shell(command, options, signal) {
      recordParallelIfReady(trace);
      const result = await engine.executeShellCommand(
        command,
        options ?? {},
        signal,
        cwd,
      );
      const exitCode = result.exitCode ?? 1;
      trace.push({ kind: "shell", command, exitCode });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
    async checkpoint(input) {
      recordParallelIfReady(trace);
      const resolved = await resolveCheckpoint(input, {
        decision,
        stdin,
        stdout,
      });
      trace.push({
        kind: "checkpoint",
        name: typeof input.name === "string" ? input.name : "checkpoint",
        decision: resolved ? "approved" : "rejected",
      });
      return resolved;
    },
  });

  const value = await execution.result;
  recordParallelIfReady(trace);
  return { value, trace, engine: PINNED_WORKFLOW_ENGINE };
}

function recordParallelIfReady(trace) {
  const hasImplement = trace.some(
    (step) => step.kind === "agent" && step.label === "implement",
  );
  const hasTests = trace.some(
    (step) => step.kind === "agent" && step.label === "tests",
  );
  const hasParallel = trace.some((step) => step.kind === "parallel");
  if (hasImplement && hasTests && !hasParallel) {
    trace.push({ kind: "parallel", name: "implement-and-test" });
  }
}

async function resolveCheckpoint(input, { decision, stdin, stdout }) {
  if (decision === "approved") return true;
  if (decision === "rejected") return false;

  const promptText =
    typeof input.prompt === "string" && input.prompt
      ? input.prompt
      : "Approve the Clamp Coach fan-out?";
  stdout.write(`${promptText}\n`);

  if (!stdin.isTTY) {
    stdout.write("checkpoint: auto-approved (non-TTY; pass --reject to stop)\n");
    return true;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question("Type approved or rejected: ")).trim().toLowerCase();
    if (answer === "rejected" || answer === "reject") return false;
    if (answer === "approved" || answer === "approve") return true;
    stdout.write("Unrecognized checkpoint answer; treating as rejected.\n");
    return false;
  } finally {
    rl.close();
  }
}

async function completeLiveAgent(promptText, options, { credentials, fetchImpl, signal }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Clamp Coach live path needs fetch()");
  }

  const label =
    typeof options.label === "string" && options.label ? options.label : "agent";
  const body =
    credentials.kind === "anthropic"
      ? anthropicBody(promptText, credentials.model)
      : openaiBody(promptText, credentials.model);
  const url =
    credentials.kind === "anthropic"
      ? `${credentials.baseUrl}/v1/messages`
      : `${credentials.baseUrl}/chat/completions`;
  const headers =
    credentials.kind === "anthropic"
      ? {
          "content-type": "application/json",
          "x-api-key": credentials.apiKey,
          "anthropic-version": "2023-06-01",
        }
      : {
          "content-type": "application/json",
          authorization: `Bearer ${credentials.apiKey}`,
        };

  const timeout = AbortSignal.timeout(LIVE_TIMEOUT_MS);
  const combined =
    typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Clamp Coach live ${label} request failed (${response.status}): ${clip(text)}`,
    );
  }

  const payload = parseJson(text, label);
  const content = credentials.kind === "anthropic"
    ? anthropicText(payload)
    : openaiText(payload);
  if (!content) {
    throw new Error(`Clamp Coach live ${label} returned an empty completion`);
  }
  return content;
}

function openaiBody(promptText, model) {
  return {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are Clamp Coach, a Pi workflow coach. Answer the implement, tests, or summary step in plain text.",
      },
      { role: "user", content: promptText },
    ],
  };
}

function anthropicBody(promptText, model) {
  return {
    model,
    max_tokens: 1024,
    system:
      "You are Clamp Coach, a Pi workflow coach. Answer the implement, tests, or summary step in plain text.",
    messages: [{ role: "user", content: promptText }],
  };
}

function openaiText(payload) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const content = choice?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

function anthropicText(payload) {
  const block = Array.isArray(payload.content) ? payload.content[0] : undefined;
  return typeof block?.text === "string" ? block.text.trim() : "";
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Clamp Coach live ${label} returned non-JSON`);
  }
}

function clip(text) {
  return String(text).replace(/\s+/g, " ").slice(0, 200);
}

function trimSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseArgs(argv) {
  const live = argv.includes("--live");
  const stub = argv.includes("--stub");
  const reject = argv.includes("--reject");
  const approve = argv.includes("--approve");
  if (live && stub) {
    throw new Error("Use only one of --live or --stub");
  }
  if (approve && reject) {
    throw new Error("Use only one of --approve or --reject");
  }
  return { live, stub, reject, approve };
}

async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(join(root, "workflow.js"), "utf8");
  const flags = parseArgs(process.argv.slice(2));
  await loadLocalEnvFile(root, process.env);
  const credentials = credentialsFromEnv(process.env);
  const agent = flags.stub ? "stub" : flags.live || credentials ? "live" : "stub";
  if (flags.live && !credentials) {
    throw new Error(
      "Clamp Coach live path needs OPENAI_API_KEY, ANTHROPIC_API_KEY, or PI_COACH_API_KEY",
    );
  }
  const decision = flags.reject ? "rejected" : flags.approve ? "approved" : undefined;
  if (agent === "live" && credentials) {
    process.stderr.write(
      `Clamp Coach live path: ${credentials.kind} ${credentials.model} via ${PINNED_WORKFLOW_ENGINE}\n`,
    );
  }
  return runWorkflow({
    source,
    cwd: root,
    decision,
    agent,
    env: process.env,
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  try {
    const result = await main();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.value?.ok === false ? 1 : 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
