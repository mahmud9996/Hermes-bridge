# Hermes Bridge v3.0 — Setup Guide (বাংলা)

> English docs: README.md, docs/cloudflare-setup.md, docs/commands.md, docs/api-reference.md

---

## এটা কেন OAuth 2.1 দরকার?

Claude.ai এবং ChatGPT MCP connector setup এ OAuth 2.1 **বাধ্যতামূলক**।
আগের version এ plain Bearer token ব্যবহার করা হয়েছিল — এটা rejected হতো।

**এখন কীভাবে কাজ করে:**
1. Claude.ai তোমার Worker URL এ যায় → `401` পায়
2. Automatically OAuth discovery করে (`/.well-known/oauth-authorization-server`)
3. নিজেই register করে (`/oauth/register`)
4. তোমাকে একটা সুন্দর Consent Page এ পাঠায়
5. তুমি `BRIDGE_SECRET` লিখে "Authorize" চাপো
6. Done — এরপর থেকে সব automatic

---

## সম্পূর্ণ Architecture

```
Claude / ChatGPT / Gemini
         ↕  OAuth 2.1 + PKCE  (প্রথমবার)
         ↕  Bearer Token       (পরবর্তী)
Cloudflare Worker  ← Persistent HTTPS URL
         ↕  Firebase REST API
Firebase Realtime DB  ← Command queue + OAuth Token store (KV)
         ↕  Polling (2s)
Termux Python Server  ← তোমার Android ফোন
         ↓
Shell · Python · Files
```

---

## ধাপ ১ — Firebase (ফ্রি)

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
2. **Build → Realtime Database → Create database**
   - Location: `asia-southeast1` (কাছের)
3. **Database URL** নোট করো:
   `https://YOUR-PROJECT-rtdb.asia-southeast1.firebasedatabase.app`
4. **Project Settings → Service Accounts → Generate new private key**
   → `credentials.json` ডাউনলোড
5. **Project Settings → Service Accounts → Database secrets** → copy করো
6. **Realtime Database → Rules** → `firebase/rules.json` paste → **Publish**

---

## ধাপ ২ — Termux

```bash
# Files Termux এ কপি করো
mkdir -p ~/hermes-bridge
cp /sdcard/Download/hermes_bridge.py ~/hermes-bridge/
cp /sdcard/Download/setup.sh ~/hermes-bridge/

# Setup চালাও (একবারই)
cd ~/hermes-bridge
bash setup.sh

# credentials দাও
cp /sdcard/Download/credentials.json ~/.hermes-bridge/credentials.json

# Firebase URL দাও
nano ~/.hermes-bridge/config.json
# "firebase_db_url" field টা আপডেট করো

# Device ID নোট করো — Cloudflare এ লাগবে
cat ~/.hermes-bridge/config.json

# Bridge চালাও
./start.sh
```

---

## ধাপ ৩ — Cloudflare Worker + KV (ফ্রি)

### ৩.১ Worker তৈরি
1. [cloudflare.com](https://cloudflare.com) → Free account
2. **Workers & Pages → Create → Create Worker**
   - নাম: `hermes-bridge`
3. `server/worker.js` পুরো content paste → **Deploy**

### ৩.২ KV Namespace তৈরি (OAuth token storage)
1. **Workers & Pages → KV → Create namespace**
   - নাম: `HERMES_BRIDGE_OAUTH`
2. **Worker → Settings → Variables → KV Namespace Bindings**
   - **Add binding** → Variable name: `OAUTH_KV`
   - KV namespace: `HERMES_BRIDGE_OAUTH` → **Save**

### ৩.৩ Environment Variables
**Worker → Settings → Variables → Environment Variables:**

| Variable | Value |
|---|---|
| `FIREBASE_DB_URL` | Firebase Database URL |
| `FIREBASE_SECRET` | Firebase Database Secret |
| `DEVICE_ID` | `config.json` এর `device_id` |
| `BRIDGE_SECRET` | যেকোনো strong password |

> প্রতিটার পাশে **"Encrypt"** চাপো → **Save**

### ৩.৪ Test করো
Browser এ:
```
https://hermes-bridge.YOUR-ACCOUNT.workers.dev/health
```
দেখাবে: `{"ok":true,"bridge":"3.0.0","device":"online"}`

---

## ধাপ ৪ — AI Connect করো

### Claude.ai
1. Settings → **Integrations → Add custom connector**
2. URL: `https://hermes-bridge.YOUR-ACCOUNT.workers.dev`
   *(root URL — Claude OAuth নিজেই discover করবে)*
3. Claude Hermes Bridge Consent Page এ নিয়ে যাবে
4. তোমার `BRIDGE_SECRET` লিখে → **Authorize** চাপো
5. Done ✅

### ChatGPT (Custom GPT — সহজ)
1. Explore GPTs → Create → Configure → **Add actions**
2. Import from URL:
   `https://hermes-bridge.YOUR-ACCOUNT.workers.dev/openapi.json`
3. Authentication: **API Key** → Bearer → তোমার `BRIDGE_SECRET`

### Gemini / অন্য AI
System prompt এ এটা দাও:
```
Android device REST API:
Base URL: https://hermes-bridge.YOUR-ACCOUNT.workers.dev
Header: Authorization: Bearer YOUR_BRIDGE_SECRET

POST /api/shell     - {"command":"ls","timeout":30}
POST /api/python    - {"code":"print('hi')"}
POST /api/file/read - {"path":"~/file.txt"}
POST /api/file/write- {"path":"~/file.txt","content":"text"}
GET  /api/status    - device online check
```

---

## Daily Use

```bash
./start.sh          # Foreground (log screen এ)
./start-bg.sh       # Background
./stop.sh           # বন্ধ
tail -f ~/.hermes-bridge/bridge.log  # Log দেখো
termux-wake-lock    # ফোন না ঘুমায়
```

---

## Troubleshooting

**"Error creating connector" Claude/ChatGPT তে:**
- Worker deploy হয়েছে? → `/health` check করো
- `OAUTH_KV` **KV namespace binding** দেওয়া হয়েছে? (env var না, binding!)
- `/.well-known/oauth-authorization-server` → JSON দেখাচ্ছে?

**Consent page এ "Incorrect Bridge Secret":**
- Cloudflare এর `BRIDGE_SECRET` variable ঠিকঠাক দেওয়া আছে?
- Case-sensitive — হুবহু মিলতে হবে

**Device "offline":**
- Bridge চলছে? → `./start.sh`
- ফোন ঘুমিয়েছে? → `termux-wake-lock`
