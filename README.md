# 🌉 Hermes Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)](CHANGELOG.md)
[![Python](https://img.shields.io/badge/Python-3.8%2B-blue.svg)](https://python.org)
[![Platform](https://img.shields.io/badge/Platform-Termux%2FAndroid-green.svg)](https://termux.dev)
[![Cost](https://img.shields.io/badge/Cost-%240%2Fmonth-brightgreen.svg)](#cost-breakdown)

> **Connect Claude, ChatGPT, Gemini, or any AI to your Android device — free, forever.**

Hermes Bridge lets any AI assistant execute shell commands, run Python scripts, and
manage files on your Android phone running [Termux](https://termux.dev), through a
secure cloud relay you own and control.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Why OAuth 2.1?](#why-oauth-21)
- [Features](#features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [AI Integration](#ai-integration)
- [Available Tools](#available-tools)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Security Model](#security-model)
- [Free Domain Options](#free-domain-options)
- [Cost Breakdown](#cost-breakdown)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│              AI Assistants                                     │
│  Claude.ai (MCP) · ChatGPT (MCP/Actions) · Gemini (REST)    │
└───────────────────────┬──────────────────────────────────────┘
                        │  OAuth 2.1 + PKCE  (first connect)
                        │  Bearer token       (subsequent calls)
                        ▼
┌──────────────────────────────────────────────────────────────┐
│              Cloudflare Worker                                 │
│  OAuth 2.1 Authorization Server  (RFC 8414 + RFC 7591)       │
│  MCP Streamable HTTP endpoint    (POST /)                     │
│  MCP SSE endpoint                (GET /sse)  ← compatibility  │
│  REST API                        (POST /api/*)                │
│  ★ Persistent HTTPS URL — never changes                      │
└───────────────────────┬──────────────────────────────────────┘
                        │  Firebase REST API (Database Secret)
                        ▼
┌──────────────────────────────────────────────────────────────┐
│              Firebase Realtime Database                        │
│  OAuth token store (via Cloudflare KV)                       │
│  Command queue · Result store · Device presence              │
│  ★ Zero Trust security rules — deny everything by default    │
└───────────────────────┬──────────────────────────────────────┘
                        │  Polling every 2s (outbound only)
                        ▼
┌──────────────────────────────────────────────────────────────┐
│              Termux Python Server  (your Android phone)       │
│  Polls Firebase · Executes commands · Returns results        │
│  ★ No inbound port — device never exposed to internet        │
└──────────────────────────────────────────────────────────────┘
```

---

## Why OAuth 2.1?

Claude.ai and ChatGPT's MCP integration wizards **require OAuth 2.1** with
[Dynamic Client Registration (RFC 7591)](https://datatracker.ietf.org/doc/html/rfc7591)
and PKCE. A plain Bearer-token-only server is rejected with "Error creating connector".

| Platform | Required auth |
|---|---|
| Claude.ai MCP Connector | OAuth 2.1 + PKCE + Dynamic Client Registration |
| ChatGPT MCP App | OAuth 2.1 + PKCE + Dynamic Client Registration |
| ChatGPT Custom GPT Actions | API Key (Bearer) *or* OAuth |
| Gemini / any AI with HTTP | REST API — Bearer token |

**Hermes Bridge IS the OAuth Authorization Server.** No Auth0, no Okta, no paid
identity service needed. Users "log in" by entering the `BRIDGE_SECRET` on a
simple consent page hosted by the Cloudflare Worker itself.

OAuth endpoints exposed:

| Endpoint | RFC | Description |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Server metadata / discovery |
| `GET /.well-known/oauth-protected-resource` | RFC 9470 | Protected resource metadata |
| `POST /oauth/register` | RFC 7591 | Dynamic Client Registration |
| `GET /oauth/authorize` | RFC 6749 | Consent HTML form |
| `POST /oauth/authorize` | RFC 6749 | Validate password, issue auth code |
| `POST /oauth/token` | RFC 6749 | Exchange code → access token (PKCE verified) |

---

## Features

- 🔒 **OAuth 2.1** — full Authorization Code + PKCE flow, no third-party auth service
- 🤖 **Multi-AI** — Claude (MCP), ChatGPT (MCP + Actions), Gemini, any AI via REST
- 🔄 **Persistent URL** — Cloudflare Worker URL never changes across Termux restarts
- 🛡️ **Zero Trust** — Firebase deny-by-default rules + OAuth Bearer token validation
- 💰 **Completely free** — Firebase Spark plan + Cloudflare Workers + KV free tier
- 📱 **Android-native** — runs in Termux, no root required
- 🚀 **Auto-start** — Termux:Boot support for launch on phone reboot
- 🔧 **Shell access** — full terminal command execution
- 🐍 **Python execution** — run Python 3 scripts remotely
- 📁 **File operations** — read and write files on the device
- 💓 **Heartbeat** — online/offline presence tracking
- 🧹 **Auto-cleanup** — expired commands purged automatically

---

## Requirements

### Android / Termux
- Android 7.0+
- [Termux](https://f-droid.org/packages/com.termux/) from **F-Droid** (not Play Store)
- Python 3.8+ (`pkg install python`)
- Optional: [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) for auto-start

### Cloud (all free)
- [Firebase](https://firebase.google.com) account — Spark (free) plan
- [Cloudflare](https://cloudflare.com) account — Workers free plan

### AI
- Claude: Pro, Team, or Enterprise (for MCP Integrations)
- ChatGPT: Plus or Team (for Custom GPT Actions or MCP App)
- Any AI with HTTP tool-calling: works via REST API with no account requirement

---

## Quick Start

### Step 1 — Firebase

1. [Firebase Console](https://console.firebase.google.com) → **Add project**
2. **Build → Realtime Database → Create database**
   - Region: closest to you (e.g. `asia-southeast1`)
   - Start in test mode
3. Note the **Database URL**: `https://YOUR-PROJECT-rtdb.REGION.firebasedatabase.app`
4. **Project Settings → Service Accounts → Generate new private key** → save as `credentials.json`
5. **Project Settings → Service Accounts → Database secrets** → copy the secret
6. **Realtime Database → Rules** → paste [`firebase/rules.json`](firebase/rules.json) → **Publish**

### Step 2 — Termux

```bash
# Copy files to phone
mkdir -p ~/hermes-bridge
# → copy hermes_bridge.py and setup.sh to ~/hermes-bridge/

# Run one-time setup
cd ~/hermes-bridge
bash setup.sh

# Place Firebase credentials
cp /sdcard/Download/credentials.json ~/.hermes-bridge/credentials.json

# Add Firebase Database URL to config
nano ~/.hermes-bridge/config.json
# Set: "firebase_db_url": "https://YOUR-PROJECT-rtdb.REGION.firebasedatabase.app"

# Note your device_id — needed for Cloudflare setup
cat ~/.hermes-bridge/config.json | grep device_id

# Start the bridge
./start.sh
```

### Step 3 — Cloudflare Worker

1. Sign up at [cloudflare.com](https://cloudflare.com) (free)
2. **Workers & Pages → Create → Create Worker** → name: `hermes-bridge`
3. Paste [`server/worker.js`](server/worker.js) → **Deploy**
4. **Workers & Pages → KV → Create namespace** → name: `HERMES_BRIDGE_OAUTH`
5. **Worker → Settings → Variables → KV Namespace Bindings** → add `OAUTH_KV` → select namespace
6. **Worker → Settings → Variables → Environment Variables** → add:

   | Variable | Value |
   |---|---|
   | `FIREBASE_DB_URL` | Your Firebase Database URL |
   | `FIREBASE_SECRET` | Firebase Database Secret |
   | `DEVICE_ID` | `device_id` from `~/.hermes-bridge/config.json` |
   | `BRIDGE_SECRET` | Any strong password (users enter this to authorize) |

7. Test: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev/health`

> Full guide: [`docs/cloudflare-setup.md`](docs/cloudflare-setup.md)

### Step 4 — Connect Your AI

See [AI Integration](#ai-integration) below.

---

## AI Integration

### Claude.ai

1. **Settings → Integrations → Add custom connector**
2. URL: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev`
   *(the root URL — Claude discovers OAuth automatically)*
3. Claude redirects you to the Hermes Bridge consent page
4. Enter your `BRIDGE_SECRET` → **Authorize**
5. OAuth flow completes automatically

### ChatGPT (MCP App)

1. **ChatGPT → Settings → Connected apps → Add**
2. URL: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev`
3. Follow the OAuth consent flow → enter `BRIDGE_SECRET`

### ChatGPT (Custom GPT Actions — API key, simpler)

1. **ChatGPT → Explore GPTs → Create → Configure → Add actions**
2. **Import from URL**: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev/openapi.json`
3. Authentication: **API Key** → Bearer → your `BRIDGE_SECRET`

### Gemini / Any AI with HTTP

Add to your system prompt:

```
You can control an Android device via REST API.

Base URL: https://hermes-bridge.YOUR-ACCOUNT.workers.dev
Header: Authorization: Bearer YOUR_BRIDGE_SECRET

Endpoints:
  GET  /api/status        – check if device is online
  POST /api/shell         – {"command":"ls","cwd":"~","timeout":30}
  POST /api/python        – {"code":"print('hi')","timeout":30}
  POST /api/file/read     – {"path":"~/file.txt"}
  POST /api/file/write    – {"path":"~/file.txt","content":"text"}

Always call /api/status first. Responses include: ok, stdout, stderr, exit_code, elapsed.
```

---

## Available Tools

| Tool | Description | Required parameters |
|---|---|---|
| `run_shell` | Execute a shell command in Termux | `command` |
| `run_python` | Execute Python 3 code | `code` |
| `read_file` | Read a file from Android filesystem | `path` |
| `write_file` | Write content to a file | `path`, `content` |
| `device_status` | Check online status + device info | — |

All tools return: `{ ok, stdout, stderr, exit_code, elapsed }`.

---

## API Reference

### Public endpoints (no auth)

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | API listing |
| `GET` | `/health` | Bridge + device status |
| `GET` | `/.well-known/oauth-authorization-server` | OAuth server metadata |
| `GET` | `/.well-known/oauth-protected-resource` | OAuth resource metadata |
| `POST` | `/oauth/register` | Dynamic Client Registration |
| `GET` | `/oauth/authorize` | OAuth consent page |
| `POST` | `/oauth/authorize` | Process consent form |
| `POST` | `/oauth/token` | Token endpoint |
| `GET` | `/openapi.json` | OpenAPI 3.1 schema |
| `GET` | `/.well-known/ai-plugin.json` | OpenAI Plugin manifest |

### Protected endpoints (Bearer token required)

| Method | Path | Description |
|---|---|---|
| `POST` | `/` | MCP Streamable HTTP — Claude.ai, ChatGPT |
| `GET` | `/sse` | MCP SSE stream — compatibility |
| `POST` | `/message` | MCP SSE messages — compatibility |
| `GET` | `/api/status` | Device online status |
| `POST` | `/api/shell` | Run shell command |
| `POST` | `/api/python` | Run Python code |
| `POST` | `/api/file/read` | Read a file |
| `POST` | `/api/file/write` | Write a file |

---

## Configuration

`~/.hermes-bridge/config.json` on the Android device:

| Key | Default | Description |
|---|---|---|
| `device_id` | auto UUID | Unique device ID — **never change after setup** |
| `device_name` | `"Android-Termux"` | Human-readable label |
| `firebase_db_url` | `""` | **Required** — Firebase Realtime Database URL |
| `poll_interval` | `2` | Seconds between Firebase polls |
| `cmd_timeout` | `60` | Default command timeout in seconds |
| `max_output` | `50000` | Max captured stdout in bytes |
| `allowed_types` | see below | Command type whitelist |

Cloudflare Worker — environment variables:

| Variable | Description |
|---|---|
| `FIREBASE_DB_URL` | Firebase Realtime Database URL |
| `FIREBASE_SECRET` | Firebase Database Secret |
| `DEVICE_ID` | Device ID from `config.json` |
| `BRIDGE_SECRET` | Password for OAuth consent form |
| `OAUTH_KV` | KV namespace binding (not an env var — see setup guide) |

---

## Security Model

**Layer 1 — OAuth 2.1 at the API boundary**
All MCP and REST requests require a valid Bearer token. Tokens are issued
only after the user successfully enters `BRIDGE_SECRET` in the consent form.
Tokens are stored in Cloudflare KV and expire after 24 hours.

**Layer 2 — Firebase Zero Trust rules**
The Firebase database has `".read": false, ".write": false` at the root.
All paths require `auth != null`. Write operations validate structure and
command type against an allowlist regex.

**Layer 3 — Command type whitelist**
The Termux server rejects any command whose `type` is not in `allowed_types`.
Unknown types are silently blocked before any execution.

**Layer 4 — No inbound connections**
Termux never opens a public port. It only makes outbound HTTPS requests to
Firebase. There is no network attack surface on the device.

| Credential | Location |
|---|---|
| Firebase service account | `~/.hermes-bridge/credentials.json` (device only) |
| Firebase Database Secret | Cloudflare Worker env var (encrypted at rest) |
| Bridge Secret | Cloudflare Worker env var (encrypted at rest) |
| OAuth tokens | Cloudflare KV (encrypted at rest, auto-expiring) |

---

## Free Domain Options

The Cloudflare Worker already provides a free, persistent HTTPS URL:
```
https://hermes-bridge.YOUR-ACCOUNT.workers.dev
```

For a custom domain:

| Provider | Domain format | Setup time |
|---|---|---|
| [DuckDNS](https://duckdns.org) | `*.duckdns.org` | Instant |
| [FreeDNS](https://freedns.afraid.org) | Various shared domains | Instant |
| [is-a.dev](https://is-a.dev) | `*.is-a.dev` | 1–2 days (GitHub PR) |
| [js.org](https://js.org) | `*.js.org` | 1–2 days (GitHub PR) |
| [eu.org](https://eu.org) | `*.eu.org` | 1–2 months |

Point a CNAME to `hermes-bridge.YOUR-ACCOUNT.workers.dev`, then add the custom
domain in **Worker Settings → Triggers → Custom Domains**.

---

## Cost Breakdown

| Service | Plan | Relevant limits |
|---|---|---|
| Firebase Realtime DB | Spark (Free) | 1 GB storage, 10 GB/month download |
| Cloudflare Workers | Free | 100,000 req/day |
| Cloudflare KV | Free (included) | 100,000 reads/day, 1,000 writes/day |
| `*.workers.dev` domain | Free (included) | Permanent |
| Termux | Free (F-Droid) | — |

**Total monthly cost: $0**

---

## Troubleshooting

### Bridge won't start
```bash
cat ~/.hermes-bridge/bridge.log
ls -la ~/.hermes-bridge/     # check credentials.json exists
cat ~/.hermes-bridge/config.json | grep firebase_db_url
```

### "Error creating connector" in Claude.ai / ChatGPT
- Verify the Worker is deployed: `GET /health` should return `{"ok":true,...}`
- Confirm `OAUTH_KV` **KV namespace binding** is set (not just an env variable)
- Try visiting `GET /.well-known/oauth-authorization-server` — should return JSON
- Confirm all 4 environment variables are saved and encrypted

### "Incorrect Bridge Secret" on consent page
- `BRIDGE_SECRET` in Cloudflare Worker must exactly match what you type
- The variable is case-sensitive

### Device shows "offline"
```bash
cd ~/hermes-bridge
./start.sh          # or ./start-bg.sh
termux-wake-lock    # prevent Android from killing the process
```

### Commands time out (55s)
- Check bridge is running: `ps aux | grep hermes`
- Increase `poll_interval` in config if device is slow
- Long-running tasks: run with `nohup` in background, check output via `read_file`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Ideas welcome:
- Termux:API integration (battery, camera, SMS, location)
- Push notifications
- Web dashboard for command history
- WebSocket streaming for real-time output
- Docker version of the relay server
- OAuth token refresh endpoint

---

## License

MIT License — see [LICENSE](LICENSE).

Copyright (c) 2026 Hermes Bridge Contributors
