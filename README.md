# pi-workflow-fanout

A readable four-step [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows) script. Not a product.

Context: Andrea Baccega’s [Pi Extensible Workflows: Full Guide](https://www.youtube.com/watch?v=qAiivspEHmU).

## Four primitives

Read `workflow.js`. In order:

1. **Fan-out** — `parallel` runs two `agent`s: implement `clamp`, write tests.
2. **Gate** — `shell` runs `node --test fixture/clamp.test.js`. Nonzero exit stops the run.
3. **Checkpoint** — pause for a human `"approved"` / `"rejected"`.
4. **Summary** — one `agent` reports the fan-out and gate.

The fixture already contains `clamp` and its tests so the gate can run without a live LLM. `run.js` stubs `agent` / `checkpoint` and actually executes `shell`.

## Run

```sh
node run.js            # auto-approves the checkpoint
node run.js --reject   # stop at the checkpoint
```

## Verify

```sh
npm test
```

That runs the fixture tests and checks that the graph order is implement+tests → gate → checkpoint → summary.
