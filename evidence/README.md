# AC3 live evidence

`npm run check:live` (same as `node run.js --live --approve`) writes sanitized `ac3-live.json` here.

## How to supply the key (never commit it)

Any **one** of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `PI_COACH_API_KEY`:

1. **Cursor Cloud Agents Secrets** — Runtime Secret or Environment Variable on the workspace/team. Injected into a new agent VM as an env var. Build Secrets do not reach runtime.
2. **Process env** — export the name in the shell that runs the check.
3. **`.env.local`** — gitignored copy of `.env.example`. `run.js` loads it without overriding vars already set.

Do not paste key material into chat, issue/PR bodies, commits, logs, or this directory.

Check presence only (boolean):

```sh
[ -n "$ANTHROPIC_API_KEY" ] && echo present || echo missing
```

## Re-run for Tester

```sh
npm install
npm run check:live
```

- **passed** (`ac3: "passed"`): implement + tests fan-out hit a real provider, gate exit 0, checkpoint `approved`, summary preview present. Provider kind and model name may appear; the key must not.
- **blocked** (exit 2): none of the three names were nonempty in env after loading `.env.local`. `keyPresence` is booleans only. `injectedSecretNames` / `allSecretNames` are Cloud Agent **name lists**, not values.
