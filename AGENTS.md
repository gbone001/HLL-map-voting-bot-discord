# Project: HLL CRCON Discord Automation

## Overview
- Runtime: Node.js 20 on Railway
- Discord library: `discord.js`
- Purpose: Hell Let Loose seeding, map voting, schedules, auto-mod configuration, and CRCON-backed admin controls
- Deployment target: Railway with health endpoints and Discord slash-command registration

## Entry Points
- `src/index.js` -> primary production bot entrypoint
- `src/index-AMD-desktop.js` -> alternate desktop-oriented entrypoint; keep behavior aligned when changes are mirrored there
- `src/commands/register.js` -> slash command registration

## Services
- `src/services/crcon.js` -> all CRCON API communication, request formatting, and command wrappers
- `src/services/mapVoting.js` -> polling loop, seeded/unseeded transitions, vote lifecycle, cooldowns, and match-end rotation
- `src/services/mapVotePanel.js` -> Discord embeds, buttons, select menus, and settings panels for map voting
- `src/services/scheduleManager.js` -> schedule state, transitions, custom map pools, and match-boundary schedule behavior
- `src/services/schedulePanel.js` -> Discord UI for schedule editing and schedule-specific settings
- `src/services/setupWizard.js` -> Discord-based configuration workflow for CRCON servers and admin role setup
- `src/services/configManager.js` -> persistent config loading/saving from `data/config.json`
- `src/services/voteStore.js` -> persisted vote state and restart recovery
- `src/services/automodPresetManager.js` -> reusable automod preset definitions and helpers

## Utilities
- `src/utils/logger.js` -> shared logging; use this instead of `console.log`
- `src/utils/dataPath.js` -> resolves writable runtime data paths across local and Railway environments
- `src/utils/buttonRouting.js` -> button/select custom ID parsing helpers; extend this instead of duplicating ID parsing inline

## Architecture Rules
- Keep Discord interaction orchestration in `src/index.js`, but put reusable business logic in `src/services`
- Do not call CRCON directly with raw `axios` outside `src/services/crcon.js`
- Do not write persistent bot configuration directly from commands or panels; go through `configManager`
- Do not bypass `voteStore` for vote persistence or restart recovery
- Keep schedule mutations in `scheduleManager` and schedule UI composition in `schedulePanel`
- Keep panel rendering in `mapVotePanel.js`; avoid embedding large UI builders in `index.js`
- Prefer async flows for all networked work and fail with clear logs rather than silent fallbacks

## Discord Rules
- Slash commands are the supported control surface; register new commands in `src/commands/register.js`
- Permission checks belong at the interaction boundary before privileged actions run
- Admin-facing replies should be explicit, short, and safe for production use
- Ephemeral responses are preferred for admin actions, errors, and setup feedback
- Avoid spammy follow-ups; reuse message edits and existing panels where practical

## CRCON / HLL Rules
- Assume CRCON is intermittently unavailable; all CRCON-facing features should tolerate timeouts and 5xx failures
- Add retries or backoff only in service layers, never scattered across command handlers
- Treat seeded/unseeded transitions, match start/end, and vote-active state as first-class edge cases
- Preserve recent-map cooldown behavior when adding new map-selection logic
- Keep non-seeded fallback rotation separate from active vote resolution so a finalized vote is never overwritten
- Broadcasts, map changes, whitelist changes, and automod config writes must go through `CRCONService`

## Events to Handle Carefully
- Discord slash commands
- Discord button interactions
- Discord select menu interactions
- Discord modal submissions
- Discord poll vote add/remove events
- HLL match start
- HLL match end
- Seeded to unseeded transitions
- Unseeded to seeded transitions
- Vote start, reminder, finalize, and reset flows
- Seeding-rule warnings and automod config updates

## Reliability Rules
- Log critical actions and upstream failures through `logger`
- Avoid duplicate alerts, duplicate vote cleanup, and duplicate map application
- Design for missing or partial CRCON payloads
- Keep health endpoint behavior intact: startup should report not-ready until Discord login completes
- Use environment variables for secrets and runtime IDs; never hardcode tokens or URLs

## Testing Expectations
- Add or update tests in `test/` for behavior changes
- Preserve coverage for:
  - button routing
  - map cooldown logic
  - seeded/unseeded vote behavior
  - non-seeded rotation behavior
  - CRCON degraded-mode/backoff behavior
- Prefer small, deterministic unit tests over live-service assumptions

## Implementation Guidance For Future HLL Work
- If adding a new HLL automation feature, create or extend a service under `src/services`
- If adding new admin controls, wire command registration, permission checks, service calls, and tests together in one change
- If API behavior is uncertain, document the assumption in code comments or PR notes rather than guessing silently
- Favor production-safe behavior over cleverness: explicit state, predictable logs, and maintainable flow control
