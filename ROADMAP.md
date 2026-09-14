# pi-workflow-fanout roadmap

Standing Pi workflow harness (Pi coach / fan-out → gate → checkpoint → summary).
Graduate path from the YouTube Hobby Bot teach (PR #1 merged).

## North star

- Real [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows) + live agent/LLM
- Fixed four-step graph for v1; reusable modules later
- Local OpenAI-compatible providers (LM Studio) so daily use does not require cloud keys
- One real Pi coach use-case before package extract

## How we track work

- **Phases + intent:** this file.
- **Active phase only:** one GitHub Issue labeled `ready-for-agent` (NOW).
- No Linear for YouTube Hobby.

## Phase board

| Issue | Title | Status |
|-------|--------|--------|
| [#2](https://github.com/Perk4/pi-workflow-fanout/issues/2) | Wire one real Pi coach use-case on the four-step graph | done (PR #5) |
| [#6](https://github.com/Perk4/pi-workflow-fanout/issues/6) | Local Pi providers (LM Studio / OpenAI-compatible) | done (PR #8) |
| [#3](https://github.com/Perk4/pi-workflow-fanout/issues/3) | Reusable workflow modules (post-v1) | done (PR #10) |

No open phase issues. Builder idle until CoS locks next NOW.

## NOW

_None._ Awaiting CoS / Perk lock (next likely: interview → roadmap for queued agents-harness, starting with `trace-rote-exec`).

## Kill / park

Archive if Pi is abandoned or this clearly overlaps another harness we already ship.

## Teach landed

- Four-primitive teach: PR #1 MERGED.
- ROADMAP initial: PR #4 MERGED.
- Coach use-case: PR #5 MERGED (#2 closed).
- ROADMAP #6 NOW: PR #7 MERGED.
- Local providers: PR #8 MERGED (#6 closed).
- Modules: PR #10 MERGED (#3 closed).
