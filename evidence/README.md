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
- **blocked** (exit 2): none of the three names were nonempty in env after loading `.env.local`. `keyPresence` is booleans only. `injectedSecretNames` / `allSecretNames` are Cloud Agent **name lists**, not values. `PI_COACH_PROVIDER=local` is not a cloud key; use `npm run check:local` for LM Studio.

## Local provider evidence

`npm run check:local` writes sanitized `local-live.json` here (gitignored). It probes `GET {baseUrl}/models` then runs Clamp Coach live against that host. No cloud key required.

- **passed**: local server answered implement + tests + summary, gate exit 0, checkpoint `approved`.
- **blocked** (exit 2): nothing listening at the LM Studio default (`http://127.0.0.1:1234/v1`), `/models` failed, or no model is loaded. The reason string tells you to start LM Studio and load a model.
