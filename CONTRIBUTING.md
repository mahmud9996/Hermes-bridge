# Contributing to Hermes Bridge

Thank you for your interest in contributing!

---

## Ways to Contribute

- 🐛 **Bug reports** — open an issue with reproduction steps, Worker logs, and bridge logs
- 💡 **Feature requests** — open an issue describing the use case and expected behaviour
- 📝 **Documentation** — fix typos, improve examples, add translations
- 🔧 **Code** — fix bugs or implement features; see ideas in README

---

## Development Setup

### Termux side (Python)

```bash
git clone https://github.com/YOUR-USERNAME/hermes-bridge
cd hermes-bridge/termux
pip install firebase-admin requests
python3 hermes_bridge.py   # needs config.json and credentials.json
```

### Worker side (JavaScript / Wrangler CLI)

```bash
npm install -g wrangler
wrangler login

# Create KV namespace
wrangler kv:namespace create "OAUTH_KV"
# paste the returned id into server/wrangler.toml

# Set secrets
wrangler secret put FIREBASE_DB_URL
wrangler secret put FIREBASE_SECRET
wrangler secret put DEVICE_ID
wrangler secret put BRIDGE_SECRET

# Local dev server (uses .dev.vars for secrets)
cd server
wrangler dev worker.js
```

`.dev.vars` format:
```
FIREBASE_DB_URL=https://your-project-rtdb.firebasedatabase.app
FIREBASE_SECRET=your-db-secret
DEVICE_ID=your-device-uuid
BRIDGE_SECRET=dev-password
```

---

## Code Style

### Python (`hermes_bridge.py`)
- PEP 8
- Docstrings on public classes and methods
- Type hints where practical
- Max line length: 100 characters

### JavaScript (`worker.js`)
- ES2020+, single file, no bundler required
- `const` over `let`; `async/await` over raw Promises
- Section headers with `// ─────` separators for readability
- Max line length: 100 characters

---

## Pull Request Process

1. **Fork** and create a branch: `git checkout -b fix/your-fix-name`
2. **Make focused commits** — one logical change per commit
3. **Test** against a real Firebase + Termux setup if possible
4. **Update docs** if you changed any behaviour
5. **Open a PR** with a clear title and description

### PR Checklist

- [ ] Code follows style guidelines above
- [ ] No credentials or personal data in commits
- [ ] `config.json` and `credentials.json` are listed in `.gitignore`
- [ ] README or relevant doc updated if behaviour changed

---

## Reporting Security Issues

Please **do not** open public GitHub issues for security vulnerabilities.
Contact the maintainer privately with a description and reproduction steps.

---

## Project Structure

```
hermes-bridge/
├── termux/
│   ├── hermes_bridge.py   Android/Termux polling server
│   ├── setup.sh           One-command installer
│   └── requirements.txt
├── server/
│   ├── worker.js          Cloudflare Worker (OAuth + MCP + REST)
│   └── wrangler.toml      CLI deployment config
├── firebase/
│   └── rules.json         Zero Trust security rules
└── docs/
    ├── cloudflare-setup.md  Full Cloudflare + KV + OAuth guide
    ├── commands.md          Command types with examples
    ├── api-reference.md     All HTTP endpoints
    ├── configuration.md     Config key reference
    └── setup-bn.md          Bengali setup guide
```
