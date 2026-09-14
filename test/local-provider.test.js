import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runLocalCheck } from "../scripts/check-local.js";
import {
  LM_STUDIO_DEFAULT_BASE_URL,
  LOCAL_DEFAULT_MODEL,
  LOCAL_DUMMY_API_KEY,
  PINNED_WORKFLOW_ENGINE,
  credentialsFromEnv,
  envWithLocalProvider,
  isLocalProvider,
  probeLocalProvider,
  runWorkflow,
} from "../run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "workflow.js"), "utf8");

function startOpenAICompatibleServer({
  modelId = "mock-local-model",
  completion = "ok-local",
  requiredApiKey,
} = {}) {
  const server = http.createServer((req, res) => {
    if (requiredApiKey) {
      const authorization = req.headers.authorization || "";
      if (authorization !== `Bearer ${requiredApiKey}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
        return;
      }
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: modelId }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: completion } }],
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close() {
          return new Promise((closeResolve, closeReject) => {
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          });
        },
      });
    });
  });
}

function cleanEnv(extra = {}) {
  return { PATH: process.env.PATH ?? "", ...extra };
}

test("credentialsFromEnv local provider uses LM Studio defaults without a cloud key", () => {
  assert.equal(isLocalProvider({ PI_COACH_PROVIDER: "local" }), true);
  assert.deepEqual(credentialsFromEnv({ PI_COACH_PROVIDER: "local" }), {
    kind: "local",
    apiKey: LOCAL_DUMMY_API_KEY,
    baseUrl: LM_STUDIO_DEFAULT_BASE_URL,
    model: LOCAL_DEFAULT_MODEL,
  });
  assert.equal(credentialsFromEnv({ PI_COACH_PROVIDER: "lmstudio" }).kind, "local");
  assert.equal(credentialsFromEnv({ PI_COACH_PROVIDER: "lm-studio" }).kind, "local");
});

test("credentialsFromEnv local honors base URL, model, and optional dummy key", () => {
  const creds = credentialsFromEnv({
    PI_COACH_PROVIDER: "local",
    PI_COACH_BASE_URL: "http://127.0.0.1:1234",
    PI_COACH_MODEL: "qwen2.5-coder-7b",
    PI_COACH_API_KEY: "not-a-cloud-secret",
  });
  assert.deepEqual(creds, {
    kind: "local",
    apiKey: "not-a-cloud-secret",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen2.5-coder-7b",
  });
});

test("credentialsFromEnv treats loopback OpenAI base URL without keys as local", () => {
  const creds = credentialsFromEnv({
    OPENAI_BASE_URL: "http://127.0.0.1:1234/v1",
  });
  assert.equal(creds.kind, "local");
  assert.equal(creds.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(creds.apiKey, LOCAL_DUMMY_API_KEY);
});

test("credentialsFromEnv openai provider still requires a key", () => {
  assert.equal(credentialsFromEnv({ PI_COACH_PROVIDER: "openai" }), null);
  assert.equal(credentialsFromEnv({}), null);
});

test("credentialsFromEnv local ignores exported cloud keys for Bearer", () => {
  const creds = credentialsFromEnv({
    PI_COACH_PROVIDER: "local",
    OPENAI_API_KEY: "sk-cloud-must-not-be-sent",
    ANTHROPIC_API_KEY: "sk-anthropic-must-not-be-sent",
  });
  assert.equal(creds.kind, "local");
  assert.equal(creds.apiKey, LOCAL_DUMMY_API_KEY);
});

test("credentialsFromEnv local uses PI_COACH_API_KEY even when OPENAI_API_KEY is set", () => {
  const creds = credentialsFromEnv({
    PI_COACH_PROVIDER: "local",
    PI_COACH_API_KEY: "local-secret",
    OPENAI_API_KEY: "sk-cloud-must-not-be-sent",
  });
  assert.equal(creds.kind, "local");
  assert.equal(creds.apiKey, "local-secret");
});

test("credentialsFromEnv treats bracketed IPv6 loopback as local and normalizes /v1", () => {
  const inferred = credentialsFromEnv({
    OPENAI_BASE_URL: "http://[::1]:1234",
  });
  assert.equal(inferred.kind, "local");
  assert.equal(inferred.baseUrl, "http://[::1]:1234/v1");
  assert.equal(inferred.apiKey, LOCAL_DUMMY_API_KEY);

  const explicit = credentialsFromEnv({
    PI_COACH_PROVIDER: "local",
    OPENAI_BASE_URL: "http://[::1]:1234",
  });
  assert.equal(explicit.kind, "local");
  assert.equal(explicit.baseUrl, "http://[::1]:1234/v1");
});

test("envWithLocalProvider forces local even when a cloud key is present", () => {
  const env = envWithLocalProvider({
    ANTHROPIC_API_KEY: "cloud-key",
    PI_COACH_MODEL: "claude-sonnet-4-5",
  });
  assert.equal(env.PI_COACH_PROVIDER, "local");
  const creds = credentialsFromEnv(env);
  assert.equal(creds.kind, "local");
  assert.equal(creds.apiKey, LOCAL_DUMMY_API_KEY);
});

test("live local path uses dummy Bearer key against OpenAI-compatible completions", async () => {
  const requests = [];
  const { value } = await runWorkflow({
    source,
    cwd: root,
    decision: "approved",
    agent: "live",
    env: {
      PI_COACH_PROVIDER: "local",
      PI_COACH_BASE_URL: "http://127.0.0.1:1234/v1",
      PI_COACH_MODEL: "mock-local-model",
      OPENAI_API_KEY: "sk-cloud-must-not-be-sent",
      ANTHROPIC_API_KEY: "sk-anthropic-must-not-be-sent",
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
    assert.equal(request.url, "http://127.0.0.1:1234/v1/chat/completions");
    assert.equal(request.init.headers.authorization, `Bearer ${LOCAL_DUMMY_API_KEY}`);
    assert.equal(JSON.parse(request.init.body).model, "mock-local-model");
  }
  assert.equal(value.ok, true);
});

test("live local path against an equivalent local server needs no cloud keys", async () => {
  const local = await startOpenAICompatibleServer();
  try {
    const { value, engine } = await runWorkflow({
      source,
      cwd: root,
      decision: "approved",
      agent: "live",
      env: {
        PI_COACH_PROVIDER: "local",
        PI_COACH_BASE_URL: local.baseUrl,
        PI_COACH_MODEL: "mock-local-model",
      },
    });
    assert.equal(engine, PINNED_WORKFLOW_ENGINE);
    assert.equal(value.ok, true);
    assert.equal(value.fanout.implement, "ok-local");
    assert.equal(value.fanout.tests, "ok-local");
    assert.equal(value.summary, "ok-local");
  } finally {
    await local.close();
  }
});

test("live local path fails closed with a clear message when the server is down", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        source,
        cwd: root,
        decision: "approved",
        agent: "live",
        env: {
          PI_COACH_PROVIDER: "local",
          PI_COACH_BASE_URL: "http://127.0.0.1:1/v1",
        },
      }),
    /not reachable.*LM Studio/s,
  );
});

test("probeLocalProvider reports models from a running local server", async () => {
  const local = await startOpenAICompatibleServer({ modelId: "listed-model" });
  try {
    const probe = await probeLocalProvider({ baseUrl: local.baseUrl });
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.models, ["listed-model"]);
  } finally {
    await local.close();
  }
});

test("probeLocalProvider sends the configured local key, not a hardcoded dummy", async () => {
  let authorization = null;
  const probe = await probeLocalProvider({
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "local-secret",
    fetchImpl: async (_url, init) => {
      authorization = init.headers.authorization;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ data: [{ id: "listed-model" }] });
        },
      };
    },
  });
  assert.equal(probe.ok, true);
  assert.equal(authorization, "Bearer local-secret");
});

test("probeLocalProvider authenticates against a local endpoint that requires PI_COACH_API_KEY", async () => {
  const local = await startOpenAICompatibleServer({
    modelId: "listed-model",
    requiredApiKey: "local-secret",
  });
  try {
    const denied = await probeLocalProvider({ baseUrl: local.baseUrl });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /401/);

    const allowed = await probeLocalProvider({
      baseUrl: local.baseUrl,
      apiKey: "local-secret",
    });
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowed.models, ["listed-model"]);
  } finally {
    await local.close();
  }
});

test("probeLocalProvider fails closed when nothing is listening", async () => {
  const probe = await probeLocalProvider({
    baseUrl: "http://127.0.0.1:1/v1",
  });
  assert.equal(probe.ok, false);
  assert.match(probe.reason, /not reachable/);
  assert.match(probe.reason, /LM Studio/);
});

test("CLI --live with PI_COACH_PROVIDER=local needs no cloud key and fails closed if the server is down", () => {
  const result = spawnSync(process.execPath, ["run.js", "--live", "--approve"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({
      PI_COACH_PROVIDER: "local",
      PI_COACH_BASE_URL: "http://127.0.0.1:1/v1",
      PI_COACH_MODEL: "mock-local-model",
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live path: local mock-local-model/);
  assert.match(result.stderr, /not reachable/);
  assert.match(result.stderr, /LM Studio/);
});

test("CLI stub path stays green when local provider env is set", () => {
  const result = spawnSync(process.execPath, ["run.js", "--stub"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({
      PI_COACH_PROVIDER: "local",
      PI_COACH_BASE_URL: "http://127.0.0.1:1234/v1",
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.value.ok, true);
  assert.match(String(parsed.value.summary), /stub:summary/);
});

test("check:live stays cloud-keyed when only local provider is set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clamp-coach-live-"));
  const result = spawnSync(process.execPath, ["scripts/check-live.js"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({
      PI_COACH_PROVIDER: "local",
      LIVE_EVIDENCE_DIR: dir,
    }),
  });
  assert.equal(result.status, 2, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ac3, "blocked");
  assert.match(parsed.reason, /check:local/);
});

test("check:local fails closed when LM Studio is not running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clamp-coach-local-"));
  const result = spawnSync(process.execPath, ["scripts/check-local.js"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({
      PI_COACH_PROVIDER: "local",
      PI_COACH_BASE_URL: "http://127.0.0.1:1/v1",
      LIVE_EVIDENCE_DIR: dir,
    }),
  });
  assert.equal(result.status, 2, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.local, "blocked");
  assert.match(parsed.reason, /not reachable/);
  assert.match(result.stderr, /Start LM Studio/);
});

test("check:local passes against an equivalent local OpenAI-compatible server", async () => {
  const local = await startOpenAICompatibleServer();
  try {
    const { report, exitCode } = await runLocalCheck({
      env: {
        PI_COACH_BASE_URL: local.baseUrl,
      },
      cwd: root,
    });
    assert.equal(exitCode, 0, report.reason);
    assert.equal(report.local, "passed");
    assert.equal(report.provider, "local");
    assert.equal(report.model, "mock-local-model");
    assert.equal(report.ok, true);
    assert.deepEqual(report.agents.sort(), ["implement", "summary", "tests"]);
  } finally {
    await local.close();
  }
});

test("check:local uses PI_COACH_API_KEY for the /models probe on authenticated endpoints", async () => {
  const local = await startOpenAICompatibleServer({
    requiredApiKey: "local-secret",
  });
  try {
    const blocked = await runLocalCheck({
      env: {
        PI_COACH_BASE_URL: local.baseUrl,
        OPENAI_API_KEY: "sk-cloud-must-not-be-sent",
      },
      cwd: root,
    });
    assert.equal(blocked.exitCode, 2);
    assert.equal(blocked.report.local, "blocked");
    assert.match(blocked.report.reason, /401/);

    const { report, exitCode } = await runLocalCheck({
      env: {
        PI_COACH_BASE_URL: local.baseUrl,
        PI_COACH_API_KEY: "local-secret",
        OPENAI_API_KEY: "sk-cloud-must-not-be-sent",
      },
      cwd: root,
    });
    assert.equal(exitCode, 0, report.reason);
    assert.equal(report.local, "passed");
  } finally {
    await local.close();
  }
});
