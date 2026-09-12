# pi-workflow-fanout

**Clamp Coach** independently drafts an implementation of `clamp(value, min, max)` and its tests, gates on `node --test`, pauses for a human approve/reject, then summarizes the result.

A readable four-step [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows) script. Not a product.

Pinned runtime: `pi-extensible-workflows@5.14.0`. Context: Andrea Baccega’s [Pi Extensible Workflows: Full Guide](https://www.youtube.com/watch?v=qAiivspEHmU).

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
# set OPENAI_API_KEY, or ANTHROPIC_API_KEY, or PI_COACH_API_KEY
export OPENAI_API_KEY=...          # required unless using another provider above
# export OPENAI_BASE_URL=https://api.openai.com/v1
# export PI_COACH_MODEL=gpt-4.1-mini
node run.js --live                 # TTY: type approved or rejected at the checkpoint
node run.js --live --approve       # non-interactive approve
node run.js --live --reject        # non-interactive reject
```

`node run.js` without `--stub` uses the live path when a key is present, otherwise stubs. Optional `OPENAI_BASE_URL` is an OpenAI-compatible relay. Anthropic uses `ANTHROPIC_API_KEY` and `PI_COACH_MODEL`.

Pi-native launch (agents with Pi tools) is the same `workflow.js`:

```sh
pi install npm:pi-extensible-workflows@5.14.0
# ask Pi to run workflow.js as scriptPath, then workflow_respond at the checkpoint
```

## Verify

```sh
npm test
```

That runs the fixture tests and checks that the graph order is implement+tests → gate → checkpoint → summary on the pinned worker.
