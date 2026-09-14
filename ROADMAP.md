# pi-workflow-fanout roadmap

Standing Pi workflow harness (Pi coach / fan-out → gate → checkpoint → summary).
Graduate path from the YouTube Hobby Bot teach (PR #1 merged).

## North star

- Real [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows) + live agent/LLM
- Four-step skeleton as reusable modules; Clamp Coach as the coach-specific composition
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
| [#3](https://github.com/Perk4/pi-workflow-fanout/issues/3) | Reusable workflow modules (post-v1) | **NOW** (done when merged) |

Builder order: **#6 → #3**.

## NOW

- Issue: [#3 Reusable workflow modules](https://github.com/Perk4/pi-workflow-fanout/issues/3)
- CoS locked. Skeleton extract + plan-vs-critique fan-out. Clamp Coach stays the default composition. Done when this PR merges.

## Kill / park

Archive if Pi is abandoned or this clearly overlaps another harness we already ship.

## Teach landed

- Four-primitive teach: PR #1 MERGED.
- ROADMAP initial: PR #4 MERGED.
- Coach use-case: PR #5 MERGED (#2 closed).
- Local providers: PR #8 MERGED (#6 closed).
