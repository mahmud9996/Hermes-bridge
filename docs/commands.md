# Commands Reference

All command types supported by Hermes Bridge, with request format, response format, and examples.

---

## Common Response Format

Every command returns the same structure regardless of type:

```json
{
  "ok":        true,
  "stdout":    "command output here",
  "stderr":    "",
  "exit_code": 0,
  "elapsed":   0.243
}
```

| Field | Type | Description |
|---|---|---|
| `ok` | boolean | `true` when `exit_code === 0` |
| `stdout` | string | Standard output (capped at `max_output` bytes, default 50 000) |
| `stderr` | string | Standard error (capped at 10 000 bytes) |
| `exit_code` | integer | `0` = success · non-zero = error · `-1` = bridge-level error |
| `elapsed` | number | Execution time in seconds |

---

## Command Types

### `shell` — Execute a Shell Command

Runs a command via `/bin/sh` inside Termux.

**Request fields:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | string | Yes | — | `"shell"` |
| `command` | string | Yes | — | Shell command to execute |
| `cwd` | string | No | `$HOME` | Working directory |
| `timeout` | integer | No | `60` | Max seconds before kill (capped at 300) |
| `env` | object | No | `{}` | Extra environment variables |

**REST request:**
```http
POST /api/shell
Authorization: Bearer YOUR_BRIDGE_SECRET
Content-Type: application/json

{
  "command": "ls -la ~/projects",
  "cwd": "/data/data/com.termux/files/home",
  "timeout": 15
}
```

**Response:**
```json
{
  "ok": true,
  "stdout": "total 24\ndrwxr-xr-x 3 u0_a123 u0_a123 4096 Jan 01 12:00 myapp\n",
  "stderr": "",
  "exit_code": 0,
  "elapsed": 0.082
}
```

**More examples:**

```json
{"command": "df -h"}
{"command": "pip install flask"}
{"command": "git -C ~/myproject pull"}
{"command": "curl -s https://httpbin.org/ip"}
{"command": "ps aux | grep python"}
{"command": "cat /proc/meminfo | grep MemAvailable"}
{"command": "nohup python3 ~/server.py > ~/server.log 2>&1 &", "timeout": 5}
```

---

### `python` — Execute Python Code

Writes the code to a temporary file and runs it with `python3`.

**Request fields:**

| Field | Type | Required | Default |
|---|---|---|---|
| `type` | string | Yes | — |
| `code` | string | Yes | — |
| `timeout` | integer | No | `30` |

**REST request:**
```http
POST /api/python
Content-Type: application/json

{
  "code": "import sys, platform\nprint(f'Python {sys.version}')\nprint(f'OS: {platform.system()}')",
  "timeout": 10
}
```

**Response:**
```json
{
  "ok": true,
  "stdout": "Python 3.12.3 (main, ...)\nOS: Linux",
  "stderr": "",
  "exit_code": 0,
  "elapsed": 0.310
}
```

**More examples:**

```python
# HTTP request
import urllib.request, json
r = urllib.request.urlopen("https://api.github.com")
print(json.loads(r.read())["current_user_url"])
```

```python
# File processing
import json, pathlib
data = json.loads(pathlib.Path("~/data.json").expanduser().read_text())
print(f"Records: {len(data)}")
```

```python
# System info
import psutil
mem = psutil.virtual_memory()
print(f"RAM used: {mem.percent}%  Available: {mem.available // 1024 // 1024} MB")
```

---

### `file_read` — Read a File

Reads a file from the Android filesystem and returns its text content.

**Request fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | `"file_read"` |
| `path` | string | Yes | File path; `~` expands to home directory |

**REST request:**
```http
POST /api/file/read
Content-Type: application/json

{"path": "~/projects/app/config.json"}
```

**Response:**
```json
{
  "ok": true,
  "stdout": "{\n  \"debug\": true,\n  \"port\": 8080\n}",
  "stderr": "",
  "exit_code": 0,
  "elapsed": 0.011
}
```

**Notes:**
- Files larger than `max_output` bytes (default 50 000) are truncated from the start
- Binary files are read with `errors="replace"` — use `shell` + `base64` for binary content

---

### `file_write` — Write a File

Writes text content to a file. Creates parent directories automatically. Overwrites existing files.

**Request fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | `"file_write"` |
| `path` | string | Yes | Destination path (`~` supported) |
| `content` | string | Yes | Text content to write |

**REST request:**
```http
POST /api/file/write
Content-Type: application/json

{
  "path": "~/projects/app/main.py",
  "content": "#!/usr/bin/env python3\nprint('Hello from AI!')\n"
}
```

**Response:**
```json
{
  "ok": true,
  "stdout": "Written: /data/data/com.termux/files/home/projects/app/main.py (42 bytes)",
  "stderr": "",
  "exit_code": 0,
  "elapsed": 0.009
}
```

---

### `ping` — Connectivity Check

Confirms the bridge is running and processing commands.

**Request:** `{"type": "ping"}`
**Response stdout:** `"pong"`

---

### `info` — Device Information

Returns system and environment info for the Termux device.

**Request:** `{"type": "info"}`

**Response stdout (JSON string):**
```json
{
  "platform": "Linux",
  "python": "3.12.3",
  "home": "/data/data/com.termux/files/home",
  "bridge_version": "3.0.0"
}
```

---

## Error Responses

### Bridge-level error (type not allowed, etc.)
```json
{"ok": false, "stdout": "", "stderr": "Blocked type: malicious", "exit_code": -1}
```

### Timeout
```json
{"ok": false, "stdout": "", "stderr": "Timeout after 60s", "exit_code": -1}
```

### Device offline (from Worker)
```json
{"ok": false, "error": "Timeout: Termux did not respond in 55s. Run ./start.sh on your phone."}
```

### Command failed (non-zero exit)
```json
{"ok": false, "stdout": "", "stderr": "bash: foo: command not found", "exit_code": 127}
```

---

## Termux Management Scripts

Created by `setup.sh` in `~/hermes-bridge/`:

| Script | Description |
|---|---|
| `./start.sh` | Start bridge in foreground — live logs on screen |
| `./start-bg.sh` | Start bridge in background — logs → `~/.hermes-bridge/bridge.log` |
| `./stop.sh` | Stop the background bridge |

```bash
# Start
cd ~/hermes-bridge && ./start-bg.sh

# Watch logs
tail -f ~/.hermes-bridge/bridge.log

# Stop
cd ~/hermes-bridge && ./stop.sh

# Prevent Android from sleeping (keeps bridge alive)
termux-wake-lock
```

---

## Pattern: Long-running Tasks

For tasks that take longer than 55 s, run them in the background and poll the output file:

**Step 1 — Start the task:**
```json
{
  "command": "nohup python3 ~/scripts/train_model.py > ~/logs/train.log 2>&1 &",
  "timeout": 5
}
```

**Step 2 — Poll the log:**
```json
{"path": "~/logs/train.log"}
```

**Step 3 — Check if it's still running:**
```json
{"command": "pgrep -f train_model.py && echo running || echo done"}
```
