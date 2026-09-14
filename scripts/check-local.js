import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOCAL_DEFAULT_MODEL,
  PINNED_WORKFLOW_ENGINE,
  credentialsFromEnv,
  envWithLocalProvider,
  loadLocalEnvFile,
  probeLocalProvider,
  runWorkflow,
} from "../run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function sanitizeLocalText(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|PI_COACH_API_KEY)=([^\s]+)/g, "$1=[redacted]");
}

function clip(text, max = 240) {
  const value = sanitizeLocalText(text).replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function writeEvidence(report) {
  const dir = process.env.LIVE_EVIDENCE_DIR
    ? process.env.LIVE_EVIDENCE_DIR
    : join(root, "evidence");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "local-live.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function resolveModel(credentials, models) {
  if (credentials.model && credentials.model !== LOCAL_DEFAULT_MODEL) {
    return credentials.model;
  }
  return models[0] || credentials.model;
}

export async function runLocalCheck({
  env = process.env,
  fetchImpl = globalThis.fetch,
  cwd = root,
  sourceText,
} = {}) {
  if (!env || typeof env !== "object") {
    throw new Error("runLocalCheck requires an env object");
  }
  const startedAt = new Date().toISOString();
  const envLocalPresent = existsSync(join(cwd, ".env.local"));
  const localEnv = envWithLocalProvider(env);
  const credentials = credentialsFromEnv(localEnv);

  const common = {
    startedAt,
    command: "npm run check:local",
    equivalent: "PI_COACH_PROVIDER=local node run.js --live --approve",
    node: process.version,
    engine: PINNED_WORKFLOW_ENGINE,
    envLocalPresent,
    provider: credentials?.kind ?? "local",
    model: credentials?.model ?? null,
    host: credentials?.baseUrl ?? null,
  };

  if (!credentials || credentials.kind !== "local") {
    return {
      exitCode: 2,
      report: {
        ...common,
        local: "blocked",
        reason: "local OpenAI-compatible provider was not selected",
        finishedAt: new Date().toISOString(),
        checkLocalExitCode: 2,
      },
    };
  }

  const probe = await probeLocalProvider({
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey,
    fetchImpl,
  });
  if (!probe.ok) {
    return {
      exitCode: 2,
      report: {
        ...common,
        local: "blocked",
        reason: probe.reason,
        models: probe.models,
        finishedAt: new Date().toISOString(),
        checkLocalExitCode: 2,
      },
    };
  }

  const model = resolveModel(credentials, probe.models);
  if (!model || (model === LOCAL_DEFAULT_MODEL && probe.models.length === 0)) {
    const reason = `No model loaded at ${credentials.baseUrl}. Load a model in LM Studio (or set PI_COACH_MODEL).`;
    return {
      exitCode: 2,
      report: {
        ...common,
        local: "blocked",
        reason,
        models: probe.models,
        finishedAt: new Date().toISOString(),
        checkLocalExitCode: 2,
      },
    };
  }

  localEnv.PI_COACH_MODEL = model;
  const source = sourceText ?? (await readFile(join(cwd, "workflow.js"), "utf8"));
  const { value, trace, engine } = await runWorkflow({
    source,
    cwd,
    decision: "approved",
    agent: "live",
    env: localEnv,
    fetchImpl,
  });

  const agentLabels = trace
    .filter((step) => step.kind === "agent")
    .map((step) => step.label);
  const gate = trace.find((step) => step.kind === "shell");
  const checkpoint = trace.find((step) => step.kind === "checkpoint");
  const passed = value?.ok === true;
  return {
    exitCode: passed ? 0 : 1,
    report: {
      local: passed ? "passed" : "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      command: "npm run check:local",
      equivalent: "PI_COACH_PROVIDER=local node run.js --live --approve",
      node: process.version,
      engine,
      provider: "local",
      model,
      host: credentials.baseUrl,
      envLocalPresent,
      models: probe.models,
      agents: agentLabels,
      gateExitCode: gate?.exitCode ?? null,
      checkpoint: checkpoint?.decision ?? null,
      checkLocalExitCode: passed ? 0 : 1,
      ok: Boolean(value?.ok),
      summaryPreview: clip(value?.summary ?? ""),
      fanoutPreview: {
        implement: clip(value?.fanout?.implement ?? "", 120),
        tests: clip(value?.fanout?.tests ?? "", 120),
      },
    },
  };
}

async function main() {
  await loadLocalEnvFile(root, process.env);
  const { report, exitCode } = await runLocalCheck({
    env: process.env,
  });
  const path = await writeEvidence(report);
  console.log(JSON.stringify(report, null, 2));
  if (exitCode !== 0) {
    const detail = report.reason ? `${report.reason} ` : "";
    console.error(
      `Local provider ${report.local}: ${detail}Wrote ${path}`,
    );
    process.exit(exitCode);
  }
  console.error(`Local provider passed. Wrote ${path}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  try {
    await main();
  } catch (error) {
    const message = sanitizeLocalText(error instanceof Error ? error.message : String(error));
    console.error(message);
    process.exit(1);
  }
}
