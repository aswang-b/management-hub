# Documentation Overview

## Where to look
| Question | File |
|---|---|
| How do I install and use the hub? (for Alex) | `README.md` |
| Rules for working on the code | `CLAUDE.md` |
| Why the hub exists, what each service's API allows, what's planned | `docs/project-brief.md` |
| Tech stack, scripts, file tree | `docs/ai-context/project-structure.md` |
| Server routes, database, link helpers | `server/CONTEXT.md` |
| Writing or fixing a plugin | `server/plugins/CONTEXT.md` |
| The page: grid, builder mode, tool types | `web/src/CONTEXT.md` |
| Which tokens each plugin needs | `.env.example` |

## Tiers
| Tier | Files | Update when |
|---|---|---|
| 1 | `CLAUDE.md`, `docs/ai-context/project-structure.md`, `docs/ai-context/docs-overview.md` | Stack, layout or conventions change |
| 2 | `server/CONTEXT.md`, `web/src/CONTEXT.md` | A component's files or patterns change |
| 3 | `server/plugins/CONTEXT.md` | Plugin framework or plugin list changes |

`README.md` and `docs/project-brief.md` sit outside the tiers: the README is
for a non-developer, and the brief's **Built?** notes track known gaps.

## Keeping docs in sync
- New plugin: README plugin table, `.env.example`, `server/plugins/CONTEXT.md`.
- New tool type: `web/src/CONTEXT.md`.
- Something from the brief built: its **Built?** note.
- Every file here stays under 200 lines.
