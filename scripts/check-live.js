import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PINNED_WORKFLOW_ENGINE,
  REQUIRED_LIVE_KEYS,
  credentialsFromEnv,
  loadLocalEnvFile,
  runWorkflow,
} from "../run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function sanitizeLiveText(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|PI_COACH_API_KEY)=([^\s]+)/g, "$1=[redacted]");
}

function clip(text, max = 240) {
  const value = sanitizeLiveText(text).replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function writeEvidence(report) {
  const dir = process.env.LIVE_EVIDENCE_DIR
    ? process.env.LIVE_EVIDENCE_DIR
    : join(root, "evidence");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "ac3-live.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function keyPresence(env = process.env) {
  return Object.fromEntries(
    REQUIRED_LIVE_KEYS.map((name) => [name, Boolean(env[name])]),
  );
}

function secretNameLists(env = process.env) {
  return {
    injectedSecretNames: env.CLOUD_AGENT_INJECTED_SECRET_NAMES || "",
    allSecretNames: env.CLOUD_AGENT_ALL_SECRET_NAMES || "",
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const envLocalPresent = existsSync(join(root, ".env.local"));
  await loadLocalEnvFile(root, process.env);
  const present = REQUIRED_LIVE_KEYS.filter((name) => Boolean(process.env[name]));
  const credentials = credentialsFromEnv(process.env);

  if (!credentials) {
    const report = {
      ac3: "blocked",
      reason: "missing live LLM credentials",
      missing: REQUIRED_LIVE_KEYS,
      present,
      keyPresence: keyPresence(process.env),
      envLocalPresent,
      startedAt,
      finishedAt: new Date().toISOString(),
      command: "npm run check:live",
      equivalent: "node run.js --live --approve",
      node: process.version,
      engine: PINNED_WORKFLOW_ENGINE,
      ...secretNameLists(process.env),
    };
    const path = await writeEvidence(report);
    console.log(JSON.stringify(report, null, 2));
    console.error(`AC3 blocked: missing ${REQUIRED_LIVE_KEYS.join(" / ")}. Wrote ${path}`);
    process.exit(2);
  }

  const source = await readFile(join(root, "workflow.js"), "utf8");
  const { value, trace, engine } = await runWorkflow({
    source,
    cwd: root,
    decision: "approved",
    agent: "live",
    env: process.env,
  });

  const agentLabels = trace
    .filter((step) => step.kind === "agent")
    .map((step) => step.label);
  const gate = trace.find((step) => step.kind === "shell");
  const checkpoint = trace.find((step) => step.kind === "checkpoint");
  const report = {
    ac3: value?.ok === true ? "passed" : "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    command: "npm run check:live",
    equivalent: "node run.js --live --approve",
    node: process.version,
    engine,
    provider: credentials.kind,
    model: credentials.model,
    host: credentials.baseUrl,
    present: REQUIRED_LIVE_KEYS.filter((name) => Boolean(process.env[name])),
    keyPresence: keyPresence(process.env),
    envLocalPresent,
    ...secretNameLists(process.env),
    agents: agentLabels,
    gateExitCode: gate?.exitCode ?? null,
    checkpoint: checkpoint?.decision ?? null,
    ok: Boolean(value?.ok),
    summaryPreview: clip(value?.summary ?? ""),
    fanoutPreview: {
      implement: clip(value?.fanout?.implement ?? "", 120),
      tests: clip(value?.fanout?.tests ?? "", 120),
    },
  };
  const path = await writeEvidence(report);
  console.log(JSON.stringify(report, null, 2));
  if (report.ac3 !== "passed") {
    console.error(`AC3 failed. Wrote ${path}`);
    process.exit(1);
  }
  console.error(`AC3 passed. Wrote ${path}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  try {
    await main();
  } catch (error) {
    const message = sanitizeLiveText(error instanceof Error ? error.message : String(error));
    console.error(message);
    process.exit(1);
  }
}
