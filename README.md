# HLL Map Vote Bot

Discord bot for Hell Let Loose seeding + map voting with schedules, automods, and per-schedule server overrides. Supports CRCON and in-progress direct RCON provider mode.

## Highlights

- Automatic map voting when player threshold is reached
- Discord poll voting flow
- Schedule manager with day/time presets, override mode, and per-schedule map pools
- Per-schedule automod configuration (Level / No Leader / No Solo Tank)
- Per-schedule general settings overrides:
  - Team Switch Cooldown
  - Idle Autokick Time
  - Max Ping Autokick
  - Map Vote Cooldown (votes to exclude recently played maps)
- Schedule export:
  - Single schedule export
  - Export all schedules
  - Includes maps, automods summary, and general settings summary
- Multi-server support (up to 4 servers)
- Persistent data path selection (`DATA_DIR` -> `/data` -> local `./data`)

## Slash Commands

This bot uses slash commands (not legacy `!` commands):

- `/mapvote setup` - Open setup wizard (Server Owner/Admin)
- `/mapvote panel [server]` - Open control panel
- `/mapvote start [server]` - Start map voting
- `/mapvote stop [server]` - Stop map voting
- `/mapvote status [server]` - Show status
- `/mapvote help` - Help text

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create `.env` from `.env.example` and set at minimum:
   - `DISCORD_TOKEN`
3. Start:
   ```bash
   npm start
   ```
4. In Discord, run `/mapvote setup` and configure server(s).

## Railway Notes

- `railway.json` is included.
- Health endpoint runs on `PORT` and responds on `/`, `/health`, `/ready`.
- For persistent config/schedules/votes, mount a volume at `/data` (or set `DATA_DIR`).

## Environment Variables

Minimum:

- `DISCORD_TOKEN` - Discord bot token

Optional:

- `GUILD_ID` - Speeds up slash command refresh in your main guild
- `DATA_DIR` - Override data directory path
- `CRCON_API_URL`, `CRCON_API_TOKEN` (+ `_2`, `_3`, `_4`) - Optional pre-seed config via env
- `SERVER_PROVIDER` (+ suffixes) - `crcon` (default) or `rcon`
- `RCON_HOST`, `RCON_PORT`, `RCON_PASSWORD` (+ suffixes) - Direct RCON connection settings
- `RCON_POLL_INTERVAL_MS` - RCON background poll interval (default: `5000`)
- `MAP_VOTE_CHANNEL_ID` (+ suffixes) - Optional pre-seed channel mapping
- `EXCLUDE_PLAYED_MAP_FOR_XVOTES` (+ suffixes) - Server default map cooldown fallback

Suffix examples:
- Server 1: `RCON_HOST`, `SERVER_PROVIDER`
- Server 2: `RCON_HOST_2`, `SERVER_PROVIDER_2`

RCON mode notes:
- General settings commands (team switch cooldown, idle kick, max ping) are wired directly to RCON.
- Map sequence and map change flows are wired.
- CRCON-specific automod endpoints are not available in direct RCON mode yet.

## Control Panel Areas

- Main panel: start/stop, settings, whitelist/blacklist, schedules, automods, export
- Schedule Manager:
  - Add/edit/delete schedules
  - Manage maps per schedule
  - General settings per schedule
  - Automods per schedule
  - Export single/all schedules

## License

MIT
