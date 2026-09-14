import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fanoutFromWorkflowSource } from "./lib/fourStep.js";
import {
  DEFAULT_PATTERN_ID,
  getPattern,
  listPatternIds,
  workflowFileForPattern,
} from "./lib/patterns.js";

export const PINNED_WORKFLOW_ENGINE = "pi-extensible-workflows@5.14.0";
export const REQUIRED_LIVE_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "PI_COACH_API_KEY",
];
export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const LOCAL_DUMMY_API_KEY = "lm-studio";
export const LOCAL_DEFAULT_MODEL = "local-model";
export const LIVE_CREDENTIALS_ERROR =
  "Clamp Coach live path needs OPENAI_API_KEY, ANTHROPIC_API_KEY, or PI_COACH_API_KEY (or set PI_COACH_PROVIDER=local for LM Studio)";
const LIVE_TIMEOUT_MS = 60_000;
const LOCAL_PROBE_TIMEOUT_MS = 5_000;

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

export function localProviderName(env = process.env) {
  return String(env.PI_COACH_PROVIDER || "")
    .trim()
    .toLowerCase();
}

export function isLocalProvider(env = process.env) {
  const provider = localProviderName(env);
  if (provider === "local" || provider === "lmstudio" || provider === "lm-studio") {
    return true;
  }
  if (provider === "anthropic" || provider === "openai") return false;
  const baseUrl = env.PI_COACH_BASE_URL || env.OPENAI_BASE_URL || "";
  const hasCloudKey = Boolean(
    env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.PI_COACH_API_KEY,
  );
  return Boolean(baseUrl) && isLoopbackHttpUrl(baseUrl) && !hasCloudKey;
}

export function envWithLocalProvider(env = process.env) {
  if (!env || typeof env !== "object") {
    throw new Error("envWithLocalProvider requires an env object");
  }
  if (isLocalProvider(env) && localProviderName(env)) return env;
  return { ...env, PI_COACH_PROVIDER: "local" };
}

export function credentialsFromEnv(env = process.env) {
  if (isLocalProvider(env)) {
    return {
      kind: "local",
      apiKey: localApiKey(env),
      baseUrl: normalizeOpenAICompatibleBaseUrl(
        env.PI_COACH_BASE_URL || env.OPENAI_BASE_URL || LM_STUDIO_DEFAULT_BASE_URL,
      ),
      model:
        env.PI_COACH_MODEL || env.OPENAI_MODEL || env.LM_STUDIO_MODEL || LOCAL_DEFAULT_MODEL,
    };
  }

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
    baseUrl: normalizeOpenAICompatibleBaseUrl(
      env.PI_COACH_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    ),
    model: env.PI_COACH_MODEL || env.OPENAI_MODEL || "gpt-4.1-mini",
  };
}

export function localProviderUnavailableMessage(baseUrl) {
  const host = trimSlash(baseUrl || LM_STUDIO_DEFAULT_BASE_URL);
  return `Local OpenAI-compatible provider is not reachable at ${host}. Start LM Studio, load a model, and enable the local server (default ${LM_STUDIO_DEFAULT_BASE_URL}). See README "Local LM Studio".`;
}

export function isUnreachableError(error) {
  if (!error || typeof error !== "object") return false;
  const cause = "cause" in error && error.cause && typeof error.cause === "object" ? error.cause : null;
  const code = error.code || cause?.code || "";
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  const name = error.name || "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = String(error.message || "");
  return /fetch failed|ECONNREFUSED|not reachable|network/i.test(message);
}

export async function probeLocalProvider({
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (typeof baseUrl !== "string" || !baseUrl) {
    throw new Error("probeLocalProvider requires a baseUrl");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("probeLocalProvider needs fetch()");
  }

  const url = `${normalizeOpenAICompatibleBaseUrl(baseUrl)}/models`;
  const timeout = AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS);
  const combined =
    typeof AbortSignal.any === "function" && signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
  const bearer = typeof apiKey === "string" && apiKey ? apiKey : LOCAL_DUMMY_API_KEY;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}` },
      signal: combined,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        reason: `local provider /models failed (${response.status}): ${clip(text)}`,
        models: [],
      };
    }
    const payload = parseJson(text, "models");
    const models =
      payload && typeof payload === "object" && Array.isArray(payload.data)
        ? payload.data
            .map((entry) => (entry && typeof entry.id === "string" ? entry.id.trim() : ""))
            .filter(Boolean)
        : [];
    return { ok: true, models, reason: null };
  } catch (error) {
    if (isUnreachableError(error)) {
      return {
        ok: false,
        reason: localProviderUnavailableMessage(baseUrl),
        models: [],
      };
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      models: [],
    };
  }
}

function preferAnthropic(env) {
  if (env.PI_COACH_PROVIDER === "anthropic") return true;
  if (env.PI_COACH_PROVIDER === "openai") return false;
  if (env.OPENAI_API_KEY) return false;
  const model = env.PI_COACH_MODEL || env.ANTHROPIC_MODEL || "";
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL) || model.startsWith("claude");
}

function localApiKey(env) {
  return env.PI_COACH_API_KEY || LOCAL_DUMMY_API_KEY;
}

function isLoopbackHost(hostname) {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function isLoopbackHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeOpenAICompatibleBaseUrl(value) {
  const trimmed = trimSlash(String(value || ""));
  try {
    const parsed = new URL(trimmed);
    if (isLoopbackHost(parsed.hostname) && (parsed.pathname === "" || parsed.pathname === "/")) {
      return `${parsed.protocol}//${parsed.host}/v1`;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
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
  systemPrompt,
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
  if (systemPrompt !== undefined && (typeof systemPrompt !== "string" || !systemPrompt.trim())) {
    throw new Error("runWorkflow systemPrompt must be a nonempty string when set");
  }

  const engine = await loadPinnedWorkflowEngine();
  const credentials = credentialsFromEnv(env);
  if (agent === "live" && typeof completeAgent !== "function" && !credentials) {
    throw new Error(LIVE_CREDENTIALS_ERROR);
  }

  const liveSystemPrompt = systemPrompt ?? getPattern(DEFAULT_PATTERN_ID).systemPrompt;
  const liveComplete =
    typeof completeAgent === "function"
      ? completeAgent
      : credentials
        ? (promptText, options, signal) =>
            completeLiveAgent(promptText, options, {
              credentials,
              fetchImpl,
              signal,
              systemPrompt: liveSystemPrompt,
            })
        : null;

  const fanout = fanoutFromWorkflowSource(source);
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
      recordParallelIfReady(trace, fanout);
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
      recordParallelIfReady(trace, fanout);
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
  recordParallelIfReady(trace, fanout);
  return { value, trace, engine: PINNED_WORKFLOW_ENGINE };
}

function recordParallelIfReady(trace, fanout) {
  if (!fanout || !Array.isArray(fanout.labels) || fanout.labels.length < 2) {
    return;
  }
  if (typeof fanout.parallelName !== "string" || !fanout.parallelName) {
    return;
  }
  const hasAll = fanout.labels.every((label) =>
    trace.some((step) => step.kind === "agent" && step.label === label),
  );
  const hasParallel = trace.some((step) => step.kind === "parallel");
  if (hasAll && !hasParallel) {
    trace.push({ kind: "parallel", name: fanout.parallelName });
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

async function completeLiveAgent(
  promptText,
  options,
  { credentials, fetchImpl, signal, systemPrompt },
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Clamp Coach live path needs fetch()");
  }
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    throw new Error("completeLiveAgent requires a systemPrompt");
  }

  const label =
    typeof options.label === "string" && options.label ? options.label : "agent";
  const openaiCompatible = credentials.kind !== "anthropic";
  const body = openaiCompatible
    ? openaiBody(promptText, credentials.model, systemPrompt)
    : anthropicBody(promptText, credentials.model, systemPrompt);
  const url = openaiCompatible
    ? `${credentials.baseUrl}/chat/completions`
    : `${credentials.baseUrl}/v1/messages`;
  const headers = openaiCompatible
    ? {
        "content-type": "application/json",
        authorization: `Bearer ${credentials.apiKey}`,
      }
    : {
        "content-type": "application/json",
        "x-api-key": credentials.apiKey,
        "anthropic-version": "2023-06-01",
      };

  const timeout = AbortSignal.timeout(LIVE_TIMEOUT_MS);
  const combined =
    typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (credentials.kind === "local" && isUnreachableError(error)) {
      throw new Error(localProviderUnavailableMessage(credentials.baseUrl));
    }
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Clamp Coach live ${label} request failed (${response.status}): ${clip(text)}`,
    );
  }

  const payload = parseJson(text, label);
  const content = openaiCompatible ? openaiText(payload) : anthropicText(payload);
  if (!content) {
    throw new Error(`Clamp Coach live ${label} returned an empty completion`);
  }
  return content;
}

function openaiBody(promptText, model, systemPrompt) {
  return {
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      { role: "user", content: promptText },
    ],
  };
}

function anthropicBody(promptText, model, systemPrompt) {
  return {
    model,
    max_tokens: 1024,
    system: systemPrompt,
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
  if (!Array.isArray(argv)) {
    throw new Error("parseArgs requires an argv array");
  }
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
  return { live, stub, reject, approve, pattern: parsePatternArg(argv) };
}

function parsePatternArg(argv) {
  let pattern = DEFAULT_PATTERN_ID;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pattern") {
      const value = argv[i + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        throw new Error(
          `Missing --pattern id (${listPatternIds().join(" or ")})`,
        );
      }
      pattern = value;
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--pattern=")) {
      pattern = arg.slice("--pattern=".length);
    }
  }
  return getPattern(pattern).id;
}

async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  const flags = parseArgs(process.argv.slice(2));
  const pattern = getPattern(flags.pattern);
  const source = await readFile(workflowFileForPattern(pattern.id, root), "utf8");
  await loadLocalEnvFile(root, process.env);
  const credentials = credentialsFromEnv(process.env);
  const agent = flags.stub ? "stub" : flags.live || credentials ? "live" : "stub";
  if (flags.live && !credentials) {
    throw new Error(LIVE_CREDENTIALS_ERROR);
  }
  const decision = flags.reject ? "rejected" : flags.approve ? "approved" : undefined;
  if (agent === "live" && credentials) {
    process.stderr.write(
      `${pattern.title} live path: ${credentials.kind} ${credentials.model} at ${credentials.baseUrl} via ${PINNED_WORKFLOW_ENGINE}\n`,
    );
  }
  return runWorkflow({
    source,
    cwd: root,
    decision,
    agent,
    env: process.env,
    systemPrompt: pattern.systemPrompt,
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
