# CRCON API to Direct RCON Migration Plan

## Goal

Replace CRCON HTTP API dependencies with direct HLL RCON V2 commands while preserving current bot behavior.

## Current Status

- Branch: `crcon-api-to-rcon`
- Provider abstraction added:
  - `crcon` (existing behavior)
  - `rcon` (new direct provider scaffolding)
- Setup wizard can now save either provider type.
- General server settings in RCON mode are wired:
  - Team Switch Cooldown
  - Idle Autokick Time
  - Max Ping Autokick

## CRCON -> RCON Mapping

### Fully Mapped (current)

- `get_status` -> `GetServerInformation(session + players)` aggregation
- `set_broadcast` -> `ServerBroadcast`
- `set_team_switch_cooldown` -> `SetTeamSwitchCooldown`
- `set_idle_autokick_time` -> `SetIdleKickDuration`
- `set_max_ping_autokick` -> `SetHighPingThreshold`
- `set_map` / `set_map_rotation` (single map) -> `ChangeMap`
- `get_maps` (basic) -> `GetServerInformation(mapsequence)` normalized

### Partially Mapped (current)

- `get_votemap_whitelist` and related mutations:
  - Implemented as bot-managed whitelist state in `data/rcon-state.json`.
  - Not yet synchronized to a native server-side votemap system.

### Not Yet Mapped

- CRCON automod endpoints (`level`, `no_leader`, `solo_tank`)
- CRCON votemap status/config endpoints
- CRCON map history endpoint
- CRCON recent logs endpoint (`get_recent_logs`) for reminder/history parity
- Rotation editing parity (`add/remove/reset map rotation`)

## Task Breakdown

1. Provider interface hardening
2. Map metadata parity layer
3. Whitelist/rotation parity on direct RCON
4. Vote lifecycle parity without CRCON logs
5. Automod replacement strategy
6. Panel/UX capability-aware controls
7. Data migration and cleanup
8. Rollout and fallback controls

## Detailed Change List

### 1) Provider interface hardening

- Define explicit provider contract used by `index.js`, `mapVoting.js`, and panels.
- Add capability flags (e.g. `supportsAutomod`, `supportsHistory`) to prevent unsupported UI actions.
- Replace generic `get/post` escape hatches with typed calls.

### 2) Map metadata parity

- Build map catalog source for direct RCON mode:
  - Canonical map IDs
  - Pretty names
  - Night/day variants
  - Mode classification (warfare/offensive/skirmish)
- Use the catalog in whitelist, schedule export, and vote panel.

### 3) Whitelist + rotation parity

- Add server-backed rotation operations using RCON commands where available.
- Keep bot-local whitelist as fallback with clear labeling.
- Implement validation to prevent schedule maps not present in map catalog.

### 4) Vote lifecycle parity

- Replace CRCON recent log dependency with:
  - Poll state + persisted vote state
  - Session transitions from `GetServerInformation(session)`
- Ensure cooldown exclusion still uses completed vote rounds, not wall time.

### 5) Automod replacement

- Decide approach:
  - A) Keep CRCON-only automod features behind provider capability guard, or
  - B) Implement equivalent enforcement with direct RCON + rule engine.
- If B: define command/event loop requirements and persistence model.

### 6) UI capability guards

- Disable/annotate unsupported buttons in RCON mode.
- Replace CRCON-only labels with provider-neutral text.
- Add provider badge in panels and schedule export.

### 7) Data migration

- Migrate legacy server configs to include `provider`.
- Add migration for persisted schedule/general settings if needed.
- Add one-time startup migration log output.

### 8) Rollout strategy

- Keep `crcon` as default provider until parity reaches acceptance criteria.
- Add per-server provider switch and mixed-mode support.
- Add rollout checklist:
  - baseline smoke tests
  - schedule transition tests
  - cooldown correctness tests
  - restart persistence tests

## Acceptance Criteria for "CRCON Removed"

- No runtime path calls CRCON endpoints.
- All active panel actions are provider-backed or explicitly unavailable with reason.
- Map vote cooldown behavior verified per schedule and server defaults.
- Schedule exports include provider-specific general settings + automod status.
- Cold restart preserves votes/schedules/provider state in persistent data directory.
