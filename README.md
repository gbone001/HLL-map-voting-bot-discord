# Seeding Bot

Standalone Discord bot for Hell Let Loose seeding management and map voting with CRCON integration plus optional direct RCON failover.

## Features

- Automatic map voting when server reaches minimum players
- Discord poll-based voting
- CRCON whitelist integration
- Direct HLL RCON transport for supported commands
- CRCON API to direct-RCON failover for status, map application, broadcasts, and core server settings
- Multi-server support (up to 4 servers)
- Admin control panel with buttons
- Map whitelist management
- Configurable settings

## Setup

1. Clone or copy this folder
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in your values:
   ```bash
   cp .env.example .env
   ```
4. Start the bot:
   ```bash
   npm start
   ```

## Railway Deployment

This project is ready for Railway with `railway.json`.

1. Create a new Railway project from this repo
2. Set environment variables in Railway:
   - `DISCORD_TOKEN` (required)
   - `CRCON_API_URL` and `CRCON_API_TOKEN` (or configure via setup wizard)
   - optional direct-RCON settings: `HLL_RCON_HOST`, `HLL_RCON_PORT`, `HLL_RCON_PASSWORD`
   - optional `TRANSPORT_MODE=crcon-api-with-rcon-fallback`
   - optional multi-server vars: `CRCON_API_URL_2`, `CRCON_API_TOKEN_2`, etc.
3. Deploy with start command `npm start`

Notes:
- Railway injects `PORT`; the bot exposes a health endpoint on `/health`.
- Health responses return `503` until Discord login is ready, then `200`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Your Discord bot token |
| `GUILD_ID` | Your Discord server ID |
| `MAP_VOTE_CHANNEL_ID` | Channel for Server 1 map voting |
| `ADMIN_CHANNEL_ID` | Channel for admin commands |
| `TRANSPORT_MODE` | `crcon-api`, `direct-rcon`, or `crcon-api-with-rcon-fallback` |
| `CRCON_API_URL` | CRCON API URL for Server 1 |
| `CRCON_API_TOKEN` | CRCON API token for Server 1 |
| `HLL_RCON_HOST` | Direct HLL RCON host for Server 1 |
| `HLL_RCON_PORT` | Direct HLL RCON port for Server 1 |
| `HLL_RCON_PASSWORD` | Direct HLL RCON password for Server 1 |
| `EXCLUDE_PLAYED_MAP_FOR_XVOTES` | How many completed votes a map must sit out before it can return (default: 3) |

For additional servers, add `_2`, `_3`, `_4` suffixes (e.g., `MAP_VOTE_CHANNEL_ID_2`, `EXCLUDE_PLAYED_MAP_FOR_XVOTES_2`).

## Transport Modes

- `crcon-api`: existing behavior; all features go through CRCON.
- `direct-rcon`: uses direct HLL RCON only for the supported subset.
- `crcon-api-with-rcon-fallback`: tries CRCON first, then falls back to direct RCON when the API path fails.

Direct RCON currently covers:
- server status polling
- warfare-only local map catalog fallback
- current/queued map operations
- broadcasts
- team switch cooldown, idle kick, and high-ping threshold writes
- local in-process match tracking and map history for voting cooldowns

CRCON-only features stay explicit:
- CRCON votemap whitelist/config APIs
- CRCON automod APIs
- CRCON log-backed admin data

## Commands

| Command | Description |
|---------|-------------|
| `!mapvote panel [server]` | Show the control panel |
| `!mapvote start [server]` | Start map voting |
| `!mapvote stop [server]` | Stop map voting |
| `!mapvote status [server]` | Show current status |
| `!mapvote help` | Show help |

## Control Panel

Use `!mapvote panel` to show an interactive control panel with:
- Start/Pause voting
- Whitelist management
- Settings configuration
- Vote/whitelist reset

## Configuration

Default settings can be changed via the control panel:
- **Minimum Players**: Player count to activate voting (default: 50)
- **Deactivate Players**: Player count to deactivate voting (default: 40)
- **Maps Per Vote**: Number of maps in each vote (default: 8)
- **Night Map Count**: Number of night maps per vote (default: 1)

## License

MIT
