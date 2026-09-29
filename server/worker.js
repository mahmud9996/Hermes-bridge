/**
 * Hermes Bridge — Cloudflare Worker  v3.0.0
 * ==========================================
 * Universal MCP server for Claude.ai, ChatGPT, Gemini, and any AI.
 *
 * WHY OAUTH 2.1?
 *   Claude.ai and ChatGPT require OAuth 2.1 for MCP integrations.
 *   A plain Bearer/API-key approach is rejected during connector setup.
 *   This Worker IS the OAuth Authorization Server — no third-party needed.
 *
 * WHAT THIS IMPLEMENTS
 *   OAuth 2.1 Authorization Server (RFC 8414, RFC 7591, PKCE-S256)
 *     /.well-known/oauth-authorization-server  — discovery
 *     /.well-known/oauth-protected-resource    — resource metadata
 *     POST /oauth/register                     — Dynamic Client Registration
 *     GET  /oauth/authorize                    — consent HTML form
 *     POST /oauth/authorize                    — validate password, issue code
 *     POST /oauth/token                        — exchange code → access token
 *   MCP Streamable HTTP (POST /)               — Claude.ai, ChatGPT MCP
 *   MCP SSE (GET /sse + POST /message)         — compatibility
 *   REST API (POST /api/*)                     — Gemini, any AI with HTTP
 *   OpenAPI schema (GET /openapi.json)         — ChatGPT Custom GPT Actions
 *
 * REQUIRED CLOUDFLARE BINDINGS
 *   Environment variables:
 *     FIREBASE_DB_URL   Your Firebase Realtime DB URL
 *     FIREBASE_SECRET   Firebase Database Secret
 *     DEVICE_ID         device_id from ~/.hermes-bridge/config.json
 *     BRIDGE_SECRET     The password users enter in the OAuth consent form
 *   KV namespace binding (name: OAUTH_KV):
 *     Create in Dashboard → KV → Create namespace → bind as "OAUTH_KV"
 *
 * MIT License — https://github.com/YOUR-USERNAME/hermes-bridge
 */

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────
const BRIDGE_VERSION       = "3.0.0";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const TOKEN_TTL_SECONDS    = 86_400;   // 24 hours
const CODE_TTL_SECONDS     = 300;      // 5 minutes
const POLL_TIMEOUT_MS      = 55_000;   // max wait for Termux
const POLL_INTERVAL_MS     = 2_000;

// ─────────────────────────────────────────────────────────────
//  CLOUDFLARE KV HELPERS
//  Stores: OAuth clients, auth codes, access tokens
// ─────────────────────────────────────────────────────────────
const kv = {
  async get(env, key) {
    const v = await env.OAUTH_KV.get(key);
    return v ? JSON.parse(v) : null;
  },
  async set(env, key, value, ttlSeconds) {
    const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : {};
    await env.OAUTH_KV.put(key, JSON.stringify(value), opts);
  },
  async del(env, key) {
    await env.OAUTH_KV.delete(key);
  },
};

// ─────────────────────────────────────────────────────────────
//  CRYPTO UTILITIES
// ─────────────────────────────────────────────────────────────

/** Generate a cryptographically random hex token. */
function genToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

/** Base64url-encode a buffer. */
function b64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Verify PKCE: SHA-256(code_verifier) must equal the stored code_challenge.
 * https://datatracker.ietf.org/doc/html/rfc7636
 */
async function verifyPKCE(code_verifier, code_challenge) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code_verifier)
  );
  return b64url(hash) === code_challenge;
}

/** Parse application/x-www-form-urlencoded body. */
async function parseFormBody(req) {
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text).entries());
}

// ─────────────────────────────────────────────────────────────
//  RESPONSE HELPERS
// ─────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id",
};

const jsonResp = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });

const htmlResp = (html, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
//  OAUTH 2.1 — HTML CONSENT PAGE
// ─────────────────────────────────────────────────────────────
function consentPage({ client_id, redirect_uri, state,
                        code_challenge, code_challenge_method,
                        scope = "", error = "" }) {
  const esc = s => s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const errorHtml = error
    ? `<p class="error">❌ ${esc(error)}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes Bridge — Authorize</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:#f0f2f5;min-height:100vh;display:flex;
    align-items:center;justify-content:center;padding:20px}
  .card{background:#fff;border-radius:16px;padding:36px 32px;
    max-width:400px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.1);text-align:center}
  .icon{font-size:48px;margin-bottom:16px}
  h1{font-size:22px;font-weight:700;color:#1a1a2e;margin-bottom:8px}
  .sub{color:#666;font-size:14px;line-height:1.6;margin-bottom:24px}
  .error{color:#c0392b;background:#fdf2f2;border:1px solid #f5c6cb;
    padding:12px;border-radius:8px;margin-bottom:16px;font-size:14px}
  label{display:block;text-align:left;font-size:13px;font-weight:600;
    color:#444;margin-bottom:6px}
  input[type=password]{width:100%;padding:12px 16px;border:2px solid #e0e0e0;
    border-radius:8px;font-size:16px;outline:none;transition:border-color .2s;
    margin-bottom:20px}
  input[type=password]:focus{border-color:#667eea}
  button{width:100%;padding:14px;
    background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
    color:#fff;border:none;border-radius:8px;font-size:16px;
    font-weight:600;cursor:pointer;transition:opacity .2s}
  button:hover{opacity:.9}
  .footer{margin-top:20px;font-size:12px;color:#aaa}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🌉</div>
  <h1>Hermes Bridge</h1>
  <p class="sub">
    An AI assistant is requesting access to your Android device.<br>
    Enter your Bridge Secret to authorize.
  </p>
  ${errorHtml}
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id"             value="${esc(client_id)}">
    <input type="hidden" name="redirect_uri"          value="${esc(redirect_uri)}">
    <input type="hidden" name="state"                 value="${esc(state || "")}">
    <input type="hidden" name="code_challenge"        value="${esc(code_challenge || "")}">
    <input type="hidden" name="code_challenge_method" value="${esc(code_challenge_method || "S256")}">
    <input type="hidden" name="scope"                 value="${esc(scope)}">
    <label for="pw">Bridge Secret</label>
    <input type="password" id="pw" name="password"
           placeholder="Enter your Bridge Secret" autofocus>
    <button type="submit">Authorize Access</button>
  </form>
  <p class="footer">Hermes Bridge v${BRIDGE_VERSION} — MIT License</p>
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
//  OAUTH 2.1 — ENDPOINTS
// ─────────────────────────────────────────────────────────────

/** /.well-known/oauth-authorization-server  (RFC 8414) */
function oauthServerMeta(base) {
  return {
    issuer:                                base,
    authorization_endpoint:               `${base}/oauth/authorize`,
    token_endpoint:                        `${base}/oauth/token`,
    registration_endpoint:                 `${base}/oauth/register`,
    response_types_supported:              ["code"],
    grant_types_supported:                 ["authorization_code"],
    code_challenge_methods_supported:      ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported:                      ["mcp"],
  };
}

/** /.well-known/oauth-protected-resource */
function oauthResourceMeta(base) {
  return {
    resource:             base,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported:     ["mcp"],
  };
}

/**
 * POST /oauth/register — Dynamic Client Registration (RFC 7591)
 * Claude.ai and ChatGPT automatically register before the auth flow.
 */
async function handleRegister(req, env) {
  let body = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  const client_id     = genToken(16);
  const client_secret = genToken(32);  // public clients may ignore this
  const now           = Math.floor(Date.now() / 1000);

  const client = {
    client_id,
    client_secret,
    redirect_uris:  body.redirect_uris  || [],
    client_name:    body.client_name    || "AI Client",
    token_endpoint_auth_method: "none",
    grant_types:   ["authorization_code"],
    response_types: ["code"],
    created_at:    now,
  };

  await kv.set(env, `oauth:client:${client_id}`, client);

  return jsonResp({
    client_id,
    client_secret,
    client_id_issued_at:     now,
    client_secret_expires_at: 0,   // never expires
    redirect_uris:            client.redirect_uris,
    grant_types:              client.grant_types,
    response_types:           client.response_types,
    token_endpoint_auth_method: "none",
  }, 201);
}

/**
 * GET /oauth/authorize — Show consent HTML form.
 */
function handleAuthorizeGet(url) {
  const p = url.searchParams;
  const required = ["client_id", "redirect_uri", "response_type"];
  for (const r of required) {
    if (!p.get(r)) {
      return jsonResp({ error: "invalid_request", error_description: `Missing: ${r}` }, 400);
    }
  }
  return htmlResp(consentPage({
    client_id:             p.get("client_id"),
    redirect_uri:          p.get("redirect_uri"),
    state:                 p.get("state") || "",
    code_challenge:        p.get("code_challenge") || "",
    code_challenge_method: p.get("code_challenge_method") || "S256",
    scope:                 p.get("scope") || "",
  }));
}

/**
 * POST /oauth/authorize — Process consent form submission.
 * Validates the Bridge Secret, then redirects with an auth code.
 */
async function handleAuthorizePost(req, env) {
  const body = await parseFormBody(req);
  const {
    client_id, redirect_uri, state = "",
    code_challenge = "", code_challenge_method = "S256",
    scope = "", password = "",
  } = body;

  // Validate password (Bridge Secret)
  if (!env.BRIDGE_SECRET || password !== env.BRIDGE_SECRET) {
    return htmlResp(consentPage({
      client_id, redirect_uri, state,
      code_challenge, code_challenge_method, scope,
      error: "Incorrect Bridge Secret. Try again.",
    }));
  }

  // Validate client exists
  const client = await kv.get(env, `oauth:client:${client_id}`);
  if (!client) {
    return jsonResp({ error: "invalid_client" }, 400);
  }

  // Validate redirect_uri
  if (client.redirect_uris.length > 0 &&
      !client.redirect_uris.includes(redirect_uri)) {
    return jsonResp({
      error: "invalid_request",
      error_description: "redirect_uri mismatch",
    }, 400);
  }

  // Issue auth code
  const code = genToken(24);
  await kv.set(env, `oauth:code:${code}`, {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    scope,
    created_at: Date.now(),
  }, CODE_TTL_SECONDS);

  // Redirect to client
  const dest = new URL(redirect_uri);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);

  return Response.redirect(dest.toString(), 302);
}

/**
 * POST /oauth/token — Exchange auth code for access token.
 * Validates PKCE code_verifier (mandatory per OAuth 2.1).
 */
async function handleToken(req, env) {
  let body;
  const ct = req.headers.get("Content-Type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    body = await parseFormBody(req);
  } else {
    try { body = await req.json(); } catch { body = {}; }
  }

  const { grant_type, code, redirect_uri,
          code_verifier, client_id } = body;

  if (grant_type !== "authorization_code") {
    return jsonResp({
      error: "unsupported_grant_type",
      error_description: "Only authorization_code is supported",
    }, 400);
  }

  if (!code) {
    return jsonResp({ error: "invalid_request", error_description: "Missing code" }, 400);
  }

  // Look up auth code
  const codeData = await kv.get(env, `oauth:code:${code}`);
  if (!codeData) {
    return jsonResp({ error: "invalid_grant", error_description: "Code not found or expired" }, 400);
  }

  // Validate redirect_uri
  if (codeData.redirect_uri !== redirect_uri) {
    return jsonResp({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  }

  // Validate PKCE (required by OAuth 2.1)
  if (codeData.code_challenge) {
    if (!code_verifier) {
      return jsonResp({ error: "invalid_request", error_description: "Missing code_verifier" }, 400);
    }
    const valid = await verifyPKCE(code_verifier, codeData.code_challenge);
    if (!valid) {
      return jsonResp({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }
  }

  // Consume code (one-time use)
  await kv.del(env, `oauth:code:${code}`);

  // Issue access token
  const access_token = genToken(32);
  await kv.set(env, `oauth:token:${access_token}`, {
    client_id:  codeData.client_id,
    scope:      codeData.scope,
    issued_at:  Date.now(),
  }, TOKEN_TTL_SECONDS);

  return jsonResp({
    access_token,
    token_type:  "Bearer",
    expires_in:  TOKEN_TTL_SECONDS,
    scope:       codeData.scope || "mcp",
  });
}

// ─────────────────────────────────────────────────────────────
//  AUTHENTICATION MIDDLEWARE
//  Accepts: OAuth Bearer token (from KV) OR static BRIDGE_SECRET
// ─────────────────────────────────────────────────────────────

/**
 * Validates the Authorization header.
 * Returns { ok: true } or { ok: false, wwwAuth: "..." }
 */
async function authenticate(req, env, base) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, wwwAuth: `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` };
  }

  const token = authHeader.slice(7);

  // Check static BRIDGE_SECRET (for REST/API-key clients)
  if (env.BRIDGE_SECRET && token === env.BRIDGE_SECRET) {
    return { ok: true, via: "static" };
  }

  // Check OAuth token in KV
  if (env.OAUTH_KV) {
    const tokenData = await kv.get(env, `oauth:token:${token}`);
    if (tokenData) return { ok: true, via: "oauth" };
  }

  return { ok: false, wwwAuth: `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", error="invalid_token"` };
}

// ─────────────────────────────────────────────────────────────
//  FIREBASE HELPERS
// ─────────────────────────────────────────────────────────────
const fbUrl = (env, path) =>
  `${env.FIREBASE_DB_URL}/${path}.json?auth=${env.FIREBASE_SECRET}`;

async function fbGet(env, path) {
  const r = await fetch(fbUrl(env, path));
  if (!r.ok) throw new Error(`Firebase GET ${r.status}: ${path}`);
  return r.json();
}

async function fbSet(env, path, data) {
  const r = await fetch(fbUrl(env, path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`Firebase SET ${r.status}: ${path}`);
  return r.json();
}

async function fbDel(env, path) {
  await fetch(fbUrl(env, path), { method: "DELETE" });
}

// ─────────────────────────────────────────────────────────────
//  COMMAND DISPATCHER (Firebase relay to Termux)
// ─────────────────────────────────────────────────────────────
async function dispatch(env, type, payload, source = "api") {
  const cmdId  = crypto.randomUUID();
  const device = env.DEVICE_ID;

  await fbSet(env, `hermes_bridge/commands/${device}/${cmdId}`, {
    id: cmdId, type, status: "pending", source,
    created_at: Math.floor(Date.now() / 1000),
    ...payload,
  });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const result = await fbGet(env, `hermes_bridge/results/${device}/${cmdId}`);
    if (result && result.done_at) return result;
  }

  await fbDel(env, `hermes_bridge/commands/${device}/${cmdId}`);
  throw new Error(
    "Timeout: Termux did not respond in 55s. " +
    "Run ./start.sh on your phone."
  );
}

async function runTool(env, name, args, source) {
  switch (name) {
    case "run_shell":
      return dispatch(env, "shell", {
        command: args.command, cwd: args.cwd,
        timeout: Math.min(args.timeout ?? 30, 50),
        env: args.env,
      }, source);
    case "run_python":
      return dispatch(env, "python", {
        code: args.code,
        timeout: Math.min(args.timeout ?? 30, 50),
      }, source);
    case "read_file":
      return dispatch(env, "file_read", { path: args.path }, source);
    case "write_file":
      return dispatch(env, "file_write",
        { path: args.path, content: args.content }, source);
    case "device_status": {
      const d = await fbGet(env, `hermes_bridge/devices/${env.DEVICE_ID}`)
        .catch(() => null);
      if (!d) return { stdout: "Device not found", stderr: "", exit_code: 1, done_at: 1 };
      const age = Math.round(Date.now() / 1000 - (d.last_seen ?? 0));
      return {
        stdout: JSON.stringify({ ...d, last_seen_ago: `${age}s` }, null, 2),
        stderr: "", exit_code: 0, done_at: 1,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─────────────────────────────────────────────────────────────
//  MCP TOOL DEFINITIONS
// ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "run_shell",
    description: "Execute a shell command in Termux on the Android device. Returns stdout, stderr, exit_code. Use for file navigation, package installation, running scripts, or any terminal operation.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        cwd:     { type: "string", description: "Working directory (default: home)" },
        timeout: { type: "integer", description: "Timeout in seconds (max 50, default 30)" },
        env:     { type: "object",  description: "Extra environment variables" },
      },
      required: ["command"],
    },
  },
  {
    name: "run_python",
    description: "Execute Python 3 code in Termux. Returns stdout, stderr, exit_code. Use for data processing, calculations, or testing code.",
    inputSchema: {
      type: "object",
      properties: {
        code:    { type: "string",  description: "Python 3 source code" },
        timeout: { type: "integer", description: "Timeout in seconds (max 50, default 30)" },
      },
      required: ["code"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the Android/Termux filesystem. Supports ~ for home directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (e.g. ~/project/main.py)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write text to a file on Android/Termux. Creates parent directories automatically. Overwrites existing files.",
    inputSchema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Destination file path" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "device_status",
    description: "Check if the Android device is online and get device info. Call this first to confirm the device is reachable.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─────────────────────────────────────────────────────────────
//  MCP — STREAMABLE HTTP (POST /)   ← Claude.ai, ChatGPT MCP
// ─────────────────────────────────────────────────────────────
async function handleMcpStreamable(req, env) {
  let body;
  try { body = await req.json(); } catch {
    return jsonResp({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
  }

  const { method, params = {}, id } = body;

  const mcpHeader = { "Mcp-Protocol-Version": MCP_PROTOCOL_VERSION };

  if (method === "initialize") {
    return jsonResp({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo:      { name: "hermes-bridge", version: BRIDGE_VERSION },
        capabilities:    { tools: {} },
      },
    }, 200, mcpHeader);
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 204, headers: { ...CORS, ...mcpHeader } });
  }

  if (method === "tools/list") {
    return jsonResp({ jsonrpc: "2.0", id, result: { tools: TOOLS } }, 200, mcpHeader);
  }

  if (method === "tools/call") {
    const { name, arguments: args = {} } = params;
    const source = "claude";

    // Use SSE stream so the connection stays alive during Firebase polling
    const { readable, writable } = new TransformStream();
    const writer  = writable.getWriter();
    const encoder = new TextEncoder();

    const writeEvent = (data) =>
      writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

    (async () => {
      try {
        const result = await runTool(env, name, args, source);
        const isError = result.exit_code !== 0;
        const text = isError
          ? `Error (exit ${result.exit_code}):\n${result.stderr || result.stdout || "(empty)"}`
          : (result.stdout || "(no output)");

        writeEvent({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text }], isError },
        });
      } catch (e) {
        writeEvent({
          jsonrpc: "2.0", id,
          result: {
            content: [{ type: "text", text: `Bridge error: ${e.message}` }],
            isError: true,
          },
        });
      } finally {
        writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        ...CORS, ...mcpHeader,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }

  return jsonResp({
    jsonrpc: "2.0", id,
    error: { code: -32601, message: `Method not found: ${method}` },
  }, 200, mcpHeader);
}

// ─────────────────────────────────────────────────────────────
//  MCP — SSE TRANSPORT (GET /sse + POST /message)  ← compat
// ─────────────────────────────────────────────────────────────
function handleMcpSse(url) {
  const { readable, writable } = new TransformStream();
  const writer  = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (ev, data) =>
    writer.write(encoder.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));

  (async () => {
    const msgUrl = `${url.protocol}//${url.host}/message`;
    write("endpoint", msgUrl);
    const iv = setInterval(
      () => writer.write(encoder.encode(": ping\n\n")), 20_000);
    setTimeout(() => { clearInterval(iv); writer.close(); }, 270_000);
  })();

  return new Response(readable, {
    headers: {
      ...CORS,
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

async function handleMcpMessage(req, env) {
  let body;
  try { body = await req.json(); } catch {
    return jsonResp({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
  }

  const { method, params = {}, id } = body;

  if (method === "initialize") {
    return jsonResp({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "hermes-bridge", version: BRIDGE_VERSION },
        capabilities: { tools: {} },
      },
    });
  }
  if (method === "notifications/initialized") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (method === "tools/list") {
    return jsonResp({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }
  if (method === "tools/call") {
    const { name, arguments: args = {} } = params;
    try {
      const r = await runTool(env, name, args, "claude-sse");
      const isError = r.exit_code !== 0;
      const text = isError
        ? `Error (exit ${r.exit_code}):\n${r.stderr || r.stdout || "(empty)"}`
        : (r.stdout || "(no output)");
      return jsonResp({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });
    } catch (e) {
      return jsonResp({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Bridge error: ${e.message}` }], isError: true } });
    }
  }
  return jsonResp({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ─────────────────────────────────────────────────────────────
//  REST API   /api/*   (universal — Gemini, any AI with HTTP)
// ─────────────────────────────────────────────────────────────
async function handleRest(url, req, env) {
  const path   = url.pathname;
  const source = req.headers.get("X-AI-Source") ?? "api";

  if (path === "/api/status" && req.method === "GET") {
    const r = await runTool(env, "device_status", {}, source);
    let data = {};
    try { data = JSON.parse(r.stdout); } catch {}
    return jsonResp({ ok: r.exit_code === 0, data });
  }

  if (req.method !== "POST") return jsonResp({ error: "POST required" }, 405);

  let body = {};
  try { body = await req.json(); } catch {
    return jsonResp({ error: "Invalid JSON" }, 400);
  }

  const routes = {
    "/api/shell":      () => runTool(env, "run_shell",  body, source),
    "/api/python":     () => runTool(env, "run_python", body, source),
    "/api/file/read":  () => runTool(env, "read_file",  body, source),
    "/api/file/write": () => runTool(env, "write_file", body, source),
  };

  const fn = routes[path];
  if (!fn) return jsonResp({ error: `Unknown endpoint: ${path}` }, 404);

  try {
    const r = await fn();
    return jsonResp({ ok: r.exit_code === 0, stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code, elapsed: r.elapsed_sec });
  } catch (e) {
    return jsonResp({ ok: false, error: e.message }, 500);
  }
}

// ─────────────────────────────────────────────────────────────
//  OPENAPI SCHEMA  (ChatGPT Custom GPT Actions)
// ─────────────────────────────────────────────────────────────
function buildOpenApi(base) {
  const result = {
    type: "object",
    properties: {
      ok:        { type: "boolean" },
      stdout:    { type: "string"  },
      stderr:    { type: "string"  },
      exit_code: { type: "integer" },
      elapsed:   { type: "number"  },
    },
  };

  return {
    openapi: "3.1.0",
    info: { title: "Hermes Bridge", version: BRIDGE_VERSION,
      description: "Execute commands on Android/Termux from any AI" },
    servers: [{ url: base }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: { Result: result },
    },
    paths: {
      "/api/status":     { get:  { operationId: "deviceStatus", summary: "Check device online status", security: [{ bearerAuth: [] }], responses: { "200": { description: "Status", content: { "application/json": { schema: { $ref: "#/components/schemas/Result" } } } } } } },
      "/api/shell":      { post: { operationId: "runShell",     summary: "Run shell command",  security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["command"], properties: { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "integer", default: 30 } } } } } }, responses: { "200": { description: "Result", content: { "application/json": { schema: { $ref: "#/components/schemas/Result" } } } } } } },
      "/api/python":     { post: { operationId: "runPython",    summary: "Run Python code",    security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"],    properties: { code:    { type: "string" }, timeout: { type: "integer", default: 30 } } } } } }, responses: { "200": { description: "Result", content: { "application/json": { schema: { $ref: "#/components/schemas/Result" } } } } } } },
      "/api/file/read":  { post: { operationId: "readFile",     summary: "Read file",          security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["path"],    properties: { path:    { type: "string" }                                       } } } } }, responses: { "200": { description: "Result", content: { "application/json": { schema: { $ref: "#/components/schemas/Result" } } } } } } },
      "/api/file/write": { post: { operationId: "writeFile",    summary: "Write file",         security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["path","content"], properties: { path: { type: "string" }, content: { type: "string" } } } } } }, responses: { "200": { description: "Result", content: { "application/json": { schema: { $ref: "#/components/schemas/Result" } } } } } } },
    },
  };
}

// ─────────────────────────────────────────────────────────────
//  MAIN ROUTER
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const base   = `${url.protocol}//${url.host}`;

    // CORS preflight
    if (method === "OPTIONS")
      return new Response(null, { headers: CORS });

    // ──────────────────────────────────────────────────────────
    //  PUBLIC — OAuth discovery & metadata
    // ──────────────────────────────────────────────────────────
    if (path === "/.well-known/oauth-authorization-server")
      return jsonResp(oauthServerMeta(base));

    if (path === "/.well-known/oauth-protected-resource")
      return jsonResp(oauthResourceMeta(base));

    // ──────────────────────────────────────────────────────────
    //  PUBLIC — OAuth flow
    // ──────────────────────────────────────────────────────────
    if (path === "/oauth/register" && method === "POST")
      return handleRegister(request, env);

    if (path === "/oauth/authorize") {
      if (method === "GET")  return handleAuthorizeGet(url);
      if (method === "POST") return handleAuthorizePost(request, env);
    }

    if (path === "/oauth/token" && method === "POST")
      return handleToken(request, env);

    // ──────────────────────────────────────────────────────────
    //  PUBLIC — OpenAPI, Plugin manifest, Health
    // ──────────────────────────────────────────────────────────
    if (path === "/openapi.json")
      return jsonResp(buildOpenApi(base));

    if (path === "/.well-known/ai-plugin.json")
      return jsonResp({
        schema_version: "v1",
        name_for_human: "Hermes Bridge",
        name_for_model: "hermes_bridge",
        description_for_human: "Run commands on your Android device from AI.",
        description_for_model:
          "Execute shell, Python, and file operations on Android/Termux. " +
          "Call device_status first to verify the device is online.",
        auth: { type: "service_http", authorization_type: "bearer" },
        api:  { type: "openapi", url: `${base}/openapi.json` },
      });

    if (path === "/health") {
      let device = "unknown";
      try {
        const d = await fbGet(env, `hermes_bridge/devices/${env.DEVICE_ID}`);
        if (d) {
          const age = Math.round(Date.now() / 1000 - (d.last_seen ?? 0));
          device = age < 60 ? "online" : `offline (${age}s ago)`;
        }
      } catch {}
      return jsonResp({ ok: true, bridge: BRIDGE_VERSION, device });
    }

    // Root listing (only for GET)
    if (path === "/" && method === "GET")
      return new Response(
        `Hermes Bridge v${BRIDGE_VERSION}\n\n` +
        "OAuth 2.1 endpoints (public):\n" +
        "  GET  /.well-known/oauth-authorization-server\n" +
        "  GET  /.well-known/oauth-protected-resource\n" +
        "  POST /oauth/register\n" +
        "  GET  /oauth/authorize\n" +
        "  POST /oauth/token\n\n" +
        "MCP (auth required):\n" +
        "  POST /          — Streamable HTTP (Claude.ai, ChatGPT MCP)\n" +
        "  GET  /sse       — SSE transport (compatibility)\n" +
        "  POST /message   — SSE messages\n\n" +
        "REST API (auth required):\n" +
        "  GET  /api/status\n" +
        "  POST /api/shell\n" +
        "  POST /api/python\n" +
        "  POST /api/file/read\n" +
        "  POST /api/file/write\n\n" +
        "Other:\n" +
        "  GET  /health\n" +
        "  GET  /openapi.json\n",
        { headers: { ...CORS, "Content-Type": "text/plain" } }
      );

    // ──────────────────────────────────────────────────────────
    //  AUTH CHECK for all protected endpoints
    //  Returns 401 with WWW-Authenticate → triggers OAuth flow
    // ──────────────────────────────────────────────────────────
    const auth = await authenticate(request, env, base);
    if (!auth.ok) {
      return new Response(
        JSON.stringify({ error: "unauthorized" }),
        {
          status: 401,
          headers: {
            ...CORS,
            "Content-Type":     "application/json",
            "WWW-Authenticate": auth.wwwAuth,
            "Mcp-Protocol-Version": MCP_PROTOCOL_VERSION,
          },
        }
      );
    }

    // ──────────────────────────────────────────────────────────
    //  MCP — Streamable HTTP (POST /)
    //  HEAD / → return 405 Allow: POST (tells MCP client POST-only)
    // ──────────────────────────────────────────────────────────
    if (path === "/") {
      if (method === "HEAD")
        return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST", "Mcp-Protocol-Version": MCP_PROTOCOL_VERSION } });
      if (method === "POST")
        return handleMcpStreamable(request, env);
      return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST, GET, HEAD" } });
    }

    // ──────────────────────────────────────────────────────────
    //  MCP — SSE transport (compatibility)
    // ──────────────────────────────────────────────────────────
    if (path === "/sse" && method === "GET")
      return handleMcpSse(url);

    if (path === "/message" && method === "POST")
      return handleMcpMessage(request, env);

    // ──────────────────────────────────────────────────────────
    //  REST API
    // ──────────────────────────────────────────────────────────
    if (path.startsWith("/api/"))
      return handleRest(url, request, env);

    return jsonResp({ error: "Not found" }, 404);
  },
};
