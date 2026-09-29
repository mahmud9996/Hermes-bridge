# Cloudflare Worker Setup Guide

Hermes Bridge v3.0 implements OAuth 2.1, which is **required** by Claude.ai and
ChatGPT for MCP integrations. This guide shows how to deploy and configure it.

---

## Why OAuth 2.1?

| Platform | Protocol required |
|---|---|
| Claude.ai MCP Connector | OAuth 2.1 + PKCE + Dynamic Client Registration |
| ChatGPT MCP App | OAuth 2.1 + PKCE + Dynamic Client Registration |
| ChatGPT Custom GPT Actions | API Key (Bearer) OR OAuth |
| Gemini / other AIs | REST API (Bearer token or no auth) |

Bearer-token-only servers are rejected by Claude.ai and ChatGPT's MCP setup wizard.

The Hermes Bridge Worker IS the OAuth Authorization Server — no Auth0, no Okta,
no third-party service needed. Users "log in" by entering the `BRIDGE_SECRET`
in a simple consent page hosted by the Worker.

---

## Step 1 — Create the Worker

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. **Workers & Pages → Create → Create Worker**
3. Name it: `hermes-bridge`
4. Click **"Edit code"** — paste the entire contents of `server/worker.js`
5. Click **"Deploy"**
6. Note your Worker URL: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev`

---

## Step 2 — Create KV Namespace (for OAuth token storage)

The Worker uses Cloudflare KV to store OAuth clients, auth codes, and access tokens.
KV is included in the **free** Cloudflare Workers plan.

### Via Dashboard (recommended)
1. In Cloudflare Dashboard → **Workers & Pages → KV**
2. Click **"Create namespace"**
3. Name: `HERMES_BRIDGE_OAUTH`
4. Click **"Add"**

### Bind KV to the Worker
1. Go to **Workers & Pages → hermes-bridge → Settings → Variables**
2. Scroll to **"KV Namespace Bindings"**
3. Click **"Add binding"**
4. Variable name: `OAUTH_KV`
5. KV namespace: `HERMES_BRIDGE_OAUTH`
6. Click **"Save"**

---

## Step 3 — Set Environment Variables

In **Workers & Pages → hermes-bridge → Settings → Variables → Environment Variables**:

| Variable | Value | Notes |
|---|---|---|
| `FIREBASE_DB_URL` | `https://YOUR-PROJECT-rtdb.REGION.firebasedatabase.app` | From Firebase Console |
| `FIREBASE_SECRET` | Database Secret | Firebase Console → Project Settings → Service Accounts → Database secrets |
| `DEVICE_ID` | UUID from `config.json` | `cat ~/.hermes-bridge/config.json` on your phone |
| `BRIDGE_SECRET` | Any strong password | Users enter this in the OAuth consent form |

> Click **"Encrypt"** next to each secret before saving.

---

## Step 4 — Test the Deployment

Open in browser:
```
https://hermes-bridge.YOUR-ACCOUNT.workers.dev/health
```

Expected response:
```json
{ "ok": true, "bridge": "3.0.0", "device": "online" }
```

OAuth discovery (Claude.ai will fetch this automatically):
```
https://hermes-bridge.YOUR-ACCOUNT.workers.dev/.well-known/oauth-authorization-server
```

---

## Step 5 — Connect Claude.ai

1. Go to [claude.ai](https://claude.ai) → **Settings → Integrations (or Connectors)**
2. Click **"Add custom connector"** or **"Add MCP server"**
3. URL: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev`
   *(root URL — Claude discovers OAuth automatically)*
4. Claude.ai will redirect you to the **Hermes Bridge consent page**
5. Enter your `BRIDGE_SECRET`
6. Click **"Authorize"**
7. Claude.ai completes the OAuth flow automatically

---

## Step 6 — Connect ChatGPT

### Option A: ChatGPT MCP App (newer)
1. ChatGPT → **Explore GPTs → Create → Configure → Add actions**
2. URL: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev`
3. Authentication: **OAuth** → follow the consent flow

### Option B: Custom GPT Action (API key, simpler)
1. ChatGPT → Explore GPTs → Create → Configure → Add actions
2. **Import from URL**: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev/openapi.json`
3. Authentication: **API Key** → Bearer → your `BRIDGE_SECRET`

---

## How the OAuth Flow Works

```
1. Claude.ai → GET / → 401 WWW-Authenticate (triggers OAuth discovery)
2. Claude.ai → GET /.well-known/oauth-protected-resource
3. Claude.ai → GET /.well-known/oauth-authorization-server
4. Claude.ai → POST /oauth/register  (Dynamic Client Registration)
5. Claude.ai → User browser → GET /oauth/authorize?client_id=...
6. User sees consent page → enters BRIDGE_SECRET → clicks Authorize
7. Worker → redirect to https://claude.ai/api/mcp/auth_callback?code=...
8. Claude.ai → POST /oauth/token (exchange code for access token)
9. Worker → validates PKCE → issues access token → stores in KV
10. Claude.ai → POST / Authorization: Bearer {token} (all future MCP calls)
```

---

## Wrangler CLI (Alternative)

If you prefer CLI deployment:

```bash
npm install -g wrangler
wrangler login

# Create KV namespace
wrangler kv:namespace create "OAUTH_KV"
# Copy the id into server/wrangler.toml

# Set secrets
wrangler secret put FIREBASE_DB_URL
wrangler secret put FIREBASE_SECRET
wrangler secret put DEVICE_ID
wrangler secret put BRIDGE_SECRET

# Deploy
cd server
wrangler deploy
```

---

## Troubleshooting OAuth

**"Error connecting to MCP server"**
- Check Worker is deployed and accessible at `/health`
- Verify `OAUTH_KV` KV binding is set (not just the namespace)
- Check all 4 environment variables are saved

**"Incorrect Bridge Secret"**
- Check `BRIDGE_SECRET` env var matches what you typed in the form
- Variable names are case-sensitive

**"Code not found or expired"**
- Auth codes expire in 5 minutes — try the flow again
- Ensure `OAUTH_KV` binding is working (test: visit `/.well-known/oauth-authorization-server`)

**Tokens expire (24 hours)**
- Claude.ai and ChatGPT will re-authorize automatically
- Users see the consent page again once per day
