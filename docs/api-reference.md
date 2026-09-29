# API Reference

Full reference for all HTTP endpoints exposed by the Cloudflare Worker.

Base URL: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev`

---

## Authentication

### OAuth 2.1 (Claude.ai and ChatGPT)

Claude.ai and ChatGPT discover OAuth automatically from the root URL.
The complete flow happens once; subsequent requests use a Bearer token:

```
Authorization: Bearer {access_token_from_oauth}
```

Tokens expire after **24 hours**. The AI client re-authorizes automatically.

### Static API Key (REST clients, ChatGPT Custom GPT Actions)

For clients that support API Key authentication, use `BRIDGE_SECRET` directly:

```
Authorization: Bearer YOUR_BRIDGE_SECRET
```

Both methods are accepted on all protected endpoints.

### 401 Response (triggers OAuth discovery in MCP clients)

Unauthenticated requests to protected endpoints receive:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://hermes-bridge.../
                  .well-known/oauth-protected-resource"
Mcp-Protocol-Version: 2025-03-26
Content-Type: application/json

{"error": "unauthorized"}
```

MCP clients follow the `WWW-Authenticate` header to begin the OAuth flow.

---

## OAuth 2.1 Endpoints (Public)

### `GET /.well-known/oauth-authorization-server`

OAuth 2.1 Authorization Server Metadata (RFC 8414).
Fetched automatically by Claude.ai and ChatGPT during connector setup.

**Response:**
```json
{
  "issuer": "https://hermes-bridge.YOUR-ACCOUNT.workers.dev",
  "authorization_endpoint": "https://.../oauth/authorize",
  "token_endpoint": "https://.../oauth/token",
  "registration_endpoint": "https://.../oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["mcp"]
}
```

---

### `GET /.well-known/oauth-protected-resource`

OAuth 2.1 Protected Resource Metadata (RFC 9470).
Tells clients which authorization servers protect this resource.

**Response:**
```json
{
  "resource": "https://hermes-bridge.YOUR-ACCOUNT.workers.dev",
  "authorization_servers": ["https://hermes-bridge.YOUR-ACCOUNT.workers.dev"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["mcp"]
}
```

---

### `POST /oauth/register`

Dynamic Client Registration (RFC 7591).
Called automatically by Claude.ai and ChatGPT before the auth flow.

**Request body:**
```json
{
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "client_name": "Claude"
}
```

**Response `201 Created`:**
```json
{
  "client_id": "a1b2c3d4e5f6...",
  "client_secret": "...",
  "client_id_issued_at": 1704067200,
  "client_secret_expires_at": 0,
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

---

### `GET /oauth/authorize`

Shows the consent page where the user enters the Bridge Secret.

**Query parameters:**

| Parameter | Required | Description |
|---|---|---|
| `client_id` | Yes | From `/oauth/register` |
| `redirect_uri` | Yes | Where to send the auth code |
| `response_type` | Yes | Must be `"code"` |
| `state` | Recommended | CSRF protection value |
| `code_challenge` | Yes (PKCE) | Base64url(SHA256(code_verifier)) |
| `code_challenge_method` | Yes (PKCE) | Must be `"S256"` |

**Response:** `200 text/html` — consent form page.

---

### `POST /oauth/authorize`

Processes the consent form submission. Called by the browser after the user
submits the Bridge Secret.

**Body** (`application/x-www-form-urlencoded`):

| Field | Description |
|---|---|
| `password` | The `BRIDGE_SECRET` value |
| `client_id` | Passed through from GET |
| `redirect_uri` | Passed through from GET |
| `state` | Passed through from GET |
| `code_challenge` | Passed through from GET |
| `code_challenge_method` | Passed through from GET |

**Success:** `302` redirect to `redirect_uri?code=AUTH_CODE&state=STATE`

**Failure:** `200 text/html` — consent page with error message.

Auth codes expire in **5 minutes** and can only be used once.

---

### `POST /oauth/token`

Exchanges an auth code for an access token. Called by the AI client.

**Request body** (`application/x-www-form-urlencoded` or JSON):

| Field | Required | Description |
|---|---|---|
| `grant_type` | Yes | `"authorization_code"` |
| `code` | Yes | Auth code from `/oauth/authorize` redirect |
| `redirect_uri` | Yes | Must match the value used in `/oauth/authorize` |
| `code_verifier` | Yes (PKCE) | Random string used to generate `code_challenge` |
| `client_id` | Recommended | From `/oauth/register` |

**Response:**
```json
{
  "access_token": "64-char hex string",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "mcp"
}
```

**Error (PKCE mismatch):**
```json
{"error": "invalid_grant", "error_description": "PKCE verification failed"}
```

---

## MCP Endpoints (Auth Required)

### `POST /` — MCP Streamable HTTP

The primary MCP endpoint used by Claude.ai and ChatGPT.
Accepts JSON-RPC 2.0 messages and returns JSON or SSE for tool calls.

**Request headers:**
```
Authorization: Bearer {token}
Content-Type: application/json
```

**Response headers:**
```
Mcp-Protocol-Version: 2025-03-26
Content-Type: application/json   (or text/event-stream for tool calls)
```

**Supported methods:**

| Method | Description |
|---|---|
| `initialize` | MCP handshake — returns server capabilities |
| `notifications/initialized` | Acknowledgement notification |
| `tools/list` | Returns all 5 tool definitions |
| `tools/call` | Execute a tool; response is SSE stream |

**`tools/list` response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "run_shell",
        "description": "Execute a shell command in Termux...",
        "inputSchema": { "type": "object", "properties": {...}, "required": ["command"] }
      }
    ]
  }
}
```

**`tools/call` response (SSE stream):**
```
Content-Type: text/event-stream

data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"output here"}],"isError":false}}

```

---

### `GET /sse` — MCP SSE Stream (Compatibility)

Legacy SSE transport for older MCP clients.
Sends the POST endpoint URL as the first event.

**Response:**
```
Content-Type: text/event-stream

event: endpoint
data: "https://hermes-bridge.YOUR-ACCOUNT.workers.dev/message"

: ping

: ping
```

---

### `POST /message` — MCP SSE Messages (Compatibility)

Handles JSON-RPC messages for the legacy SSE transport.
Same method support as `POST /`.

---

## REST API Endpoints (Auth Required)

### `GET /api/status`

Check device online status without sending a Firebase command.

**Response:**
```json
{
  "ok": true,
  "data": {
    "status": "online",
    "last_seen": 1704067200,
    "name": "My-Phone",
    "platform": "termux-android",
    "version": "3.0.0",
    "last_seen_ago": "4s"
  }
}
```

---

### `POST /api/shell`

Execute a shell command.

**Request:**
```json
{"command": "uname -a", "cwd": "~", "timeout": 30}
```

---

### `POST /api/python`

Execute Python 3 code.

**Request:**
```json
{"code": "print(2 ** 32)", "timeout": 10}
```

---

### `POST /api/file/read`

Read a file.

**Request:**
```json
{"path": "~/config.json"}
```

---

### `POST /api/file/write`

Write a file.

**Request:**
```json
{"path": "~/notes.txt", "content": "Hello from AI\n"}
```

---

## Public Info Endpoints

### `GET /health`

```json
{"ok": true, "bridge": "3.0.0", "device": "online"}
```

Device values: `"online"` · `"offline (Xs ago)"` · `"unknown"` · `"firebase_error"`

### `GET /openapi.json`

OpenAPI 3.1 schema for all REST endpoints.
Server URL is auto-set to the Worker's current URL.
Used by ChatGPT Custom GPT Actions importer.

### `GET /.well-known/ai-plugin.json`

OpenAI Plugin manifest (legacy GPT Plugins).

---

## Timing

```
AI sends request
  → Worker writes to Firebase:          ~200 ms
  → Termux detects command:             0 – 2 s  (poll interval)
  → Command executes:                   variable
  → Termux writes result:               ~200 ms
  → Worker detects result:              0 – 2 s  (poll interval)
  → Worker returns to AI:               ~100 ms

Typical round-trip (fast command):      4 – 6 s
Maximum before Worker timeout:          55 s
```
