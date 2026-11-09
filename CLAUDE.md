# Project workflow

Describe work in ordinary language. Apply relevant workflow capabilities automatically; no command names or template setup are required from the user.

<!-- moskills:begin (managed imports - do not edit inside markers) -->
@.claude/standard/base.md
@.claude/standard/delegation.md
@.claude/standard/session-protocol.md
<!-- moskills:end -->

## Project context

- **Purpose:** mostudio — open, portable agent skill + toolkit that turns a brief or raw footage into finished short or long videos (concept, tutorial, promo, lesson, pitch) and improves every run. Source: `docs/superpowers/specs/2026-11-09-mostudio-design.md`.
- **Stack:** planned Node 22 + Python 3 + ffmpeg; renderers HyperFrames (default), Remotion, ffmpeg-only. Nothing installed yet.
- **Commands:** unknown (no code yet).
- **Project constraints:**
  1. No copied third-party code or prose. Restricted material only via clean-room process (spec §8), provenance in `docs/provenance.md`.
  2. API keys only in `.env.local`, never in chat, code or commits.
  3. Every new dependency needs the user's approval before install.
  4. `storyboard.json` never references a specific renderer.
  5. Inspiration media stays local and gitignored; never reused in outputs.
- **Value tracking:** log moskills impact in `docs/moskills-value.md`.

## Context sources

- `.claude/STATE.md`: agreed scope, dependency order, gate evidence, blockers, exact next action.
- `tasks/todo.md`: checkable plan, Finished, Still not done, and review results.
- `tasks/lessons.md`: preventive rules from prior corrections and confirmed causes.
- Existing manifests, scripts, and architecture documentation: actual stack, commands, and boundaries.

Create or update documentation only when needed for the task. Preserve project-owned instructions outside the managed imports when syncing moskills.
