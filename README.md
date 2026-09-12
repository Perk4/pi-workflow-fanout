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

Live Clamp Coach path (implement + tests fan-out call a real LLM). Credentials via env — never commit keys:

```sh
cp .env.example .env.local
# fill OPENAI_API_KEY, or ANTHROPIC_API_KEY, or PI_COACH_API_KEY in .env.local
node run.js --live                 # loads .env.local; TTY: type approved or rejected
node run.js --live --approve       # non-interactive approve
node run.js --live --reject        # non-interactive reject
```

`run.js` loads `.env.local` from the repo root (does not override vars already set in the shell). You can still `export OPENAI_API_KEY=...` instead of using a file. `node run.js` without `--stub` uses the live path when a key is present, otherwise stubs. Optional `OPENAI_BASE_URL` is an OpenAI-compatible relay. Anthropic stays Anthropic when `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `PI_COACH_PROVIDER=anthropic`, or a `claude*` model is set — including when the key is `PI_COACH_API_KEY`.

Pi-native launch (agents with Pi tools) is the same `workflow.js`:

```sh
pi install npm:pi-extensible-workflows@5.14.0
# ask Pi to run workflow.js as scriptPath, then workflow_respond at the checkpoint
```

## Verify

```sh
npm test
npm run check:live
```

`npm test` runs fixture tests and graph-order coverage on the pinned worker. `npm run check:live` runs `node run.js --live --approve`, writes sanitized evidence to `evidence/ac3-live.json`, and **fails closed (exit 2)** if `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `PI_COACH_API_KEY` are all missing.
