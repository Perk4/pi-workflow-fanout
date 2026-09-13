# pi-workflow-fanout

**Clamp Coach** independently drafts an implementation of `clamp(value, min, max)` and its tests, gates on `node --test`, pauses for a human approve/reject, then summarizes the result.

A readable four-step [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows) script. Not a product.

Pinned runtime: `pi-extensible-workflows@5.14.0` (Node **>=22.19.0**, same floor as that package). Context: Andrea Baccega’s [Pi Extensible Workflows: Full Guide](https://www.youtube.com/watch?v=qAiivspEHmU).

## Four primitives

Read `workflow.js`. In order:

1. **Fan-out** — `parallel` runs two `agent`s: implement `clamp`, write tests.
2. **Gate** — `shell` runs `node --test fixture/clamp.test.js`. Nonzero exit stops the run.
3. **Checkpoint** — pause for a human `"approved"` / `"rejected"`.
4. **Summary** — one `agent` reports the fan-out and gate.

The fixture already contains `clamp` and its tests so the gate can run without a live LLM. `run.js` executes the script on the pinned pi-extensible-workflows worker (the same sandboxed `agent` / `shell` / `checkpoint` / `parallel` runtime Pi uses). Headless `piewf run` cannot execute checkpointed workflows, so this repo hosts the worker directly instead of the Pi TUI.

## Run

Stub agents (no LLM), real worker, real gate:

```sh
npm install
node run.js --stub            # auto-approves the checkpoint on non-TTY
node run.js --stub --reject   # stop at the checkpoint
```

Live Clamp Coach path (implement + tests fan-out call a real LLM). Credentials via env or a secret store — never commit keys, never paste them into chat or PR bodies:

```sh
cp .env.example .env.local
# fill OPENAI_API_KEY, or ANTHROPIC_API_KEY, or PI_COACH_API_KEY in .env.local
node run.js --live                 # loads .env.local; TTY: type approved or rejected
node run.js --live --approve       # non-interactive approve
node run.js --live --reject        # non-interactive reject
```

See **Secrets** below. `run.js` loads `.env.local` from the repo root (does not override vars already set in the shell). You can still `export ANTHROPIC_API_KEY=...` instead of using a file. `node run.js` without `--stub` uses the live path when a key is present, otherwise stubs. Optional `OPENAI_BASE_URL` is an OpenAI-compatible relay. Anthropic stays Anthropic when `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `PI_COACH_PROVIDER=anthropic`, or a `claude*` model is set — including when the key is `PI_COACH_API_KEY`. For LM Studio with no cloud key, see **Local LM Studio**.

Pi-native launch (agents with Pi tools) is the same `workflow.js`:

```sh
pi install npm:pi-extensible-workflows@5.14.0
# ask Pi to run workflow.js as scriptPath, then workflow_respond at the checkpoint
```

## Verify

```sh
npm test
npm run check:live
npm run check:local
```

`npm test` runs fixture tests and graph-order coverage on the pinned worker. `npm run check:live` runs `node run.js --live --approve`, writes sanitized evidence to `evidence/ac3-live.json`, and **fails closed (exit 2)** if `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `PI_COACH_API_KEY` are all missing. Local LM Studio config (`PI_COACH_PROVIDER=local`) does not satisfy `check:live`; use `npm run check:local` instead.

## Local LM Studio

Clamp Coach can call a **local OpenAI-compatible** server (LM Studio’s default path) with **no cloud API key**.

1. Install [LM Studio](https://lmstudio.ai/).
2. Download and load a model.
3. Start the local server: **Developer → Start Server** (default `http://127.0.0.1:1234`).
4. Copy the model id shown in LM Studio (same id as `GET http://127.0.0.1:1234/v1/models`).

```sh
cp .env.example .env.local
```

In gitignored `.env.local`:

```sh
PI_COACH_PROVIDER=local
PI_COACH_BASE_URL=http://127.0.0.1:1234/v1
PI_COACH_MODEL=your-lm-studio-model-id
```

A dummy key is optional. This repo sends `lm-studio` when none is set; LM Studio accepts any value. Leave `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` empty for this path.

```sh
npm run check:local
# equivalent:
PI_COACH_PROVIDER=local node run.js --live --approve
```

`check:local` probes `/v1/models` first. If LM Studio (or another OpenAI-compatible local server) is not running, it **fails closed (exit 2)** with a message to start the server — it never requires a cloud key. If `PI_COACH_MODEL` is unset, it uses the first id from `/v1/models`. `--stub` and cloud-keyed `--live` / `npm run check:live` stay unchanged.

Aliases: `PI_COACH_PROVIDER=lmstudio` or `lm-studio`. A loopback `OPENAI_BASE_URL` / `PI_COACH_BASE_URL` with no cloud key is treated as local. `http://127.0.0.1:1234` (no `/v1`) is normalized to `http://127.0.0.1:1234/v1`.

## Secrets

Supply **one** provider key. Never put key material in chat, issues, PR bodies, commits, logs, or `evidence/`.

**Local file (gitignored):** copy `.env.example` to `.env.local` and fill `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `PI_COACH_API_KEY`. `.env` / `.env.local` are in `.gitignore`.

**Shell env:** `export ANTHROPIC_API_KEY=...` in the process that runs `check:live`. Already-set env vars win over `.env.local`.

**Cursor Cloud Agents:** add the same name in the Cloud Agents **Secrets** dashboard for this workspace/team as a **Runtime Secret** (or Environment Variable). Cursor injects it as an env var when a **new** agent starts. Existing VMs do not pick up newly added secrets. A Build Secret is not visible at runtime and will not clear AC3.

Confirm presence without echoing the value:

```sh
[ -n "$ANTHROPIC_API_KEY" ] && echo present || echo missing
npm run check:live
```

Passed evidence (`evidence/ac3-live.json`) records exit status, provider kind, model, implement+tests+summary labels, gate exit, checkpoint, and a redacted summary preview — never the key. See `evidence/README.md`. Local provider smoke writes `evidence/local-live.json` (gitignored) via `npm run check:local`.
