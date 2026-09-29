#!/usr/bin/env python3
"""
Hermes Bridge — Termux Server  v3.0.0
======================================
Polls Firebase for commands from any AI assistant and executes them locally.
MIT License — https://github.com/YOUR-USERNAME/hermes-bridge
"""

import os, sys, json, uuid, time, logging, subprocess, threading
from pathlib import Path

CONFIG_DIR  = Path.home() / ".hermes-bridge"
CONFIG_FILE = CONFIG_DIR / "config.json"
CRED_FILE   = CONFIG_DIR / "credentials.json"
LOG_FILE    = CONFIG_DIR / "bridge.log"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("HermesBridge")

def _pip(*pkgs):
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", *pkgs], check=True)

try:
    import firebase_admin
    from firebase_admin import credentials, db
except ImportError:
    log.info("Installing firebase-admin...")
    _pip("firebase-admin")
    import firebase_admin
    from firebase_admin import credentials, db

_DEFAULTS = {
    "device_id": str(uuid.uuid4()),
    "device_name": "Android-Termux",
    "firebase_db_url": "",
    "poll_interval": 2,
    "cmd_timeout": 60,
    "max_output": 50_000,
    "allowed_types": ["shell", "python", "file_read", "file_write", "ping", "info"],
    "version": "3.0.0",
}


class Config:
    def __init__(self):
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE, encoding="utf-8") as f:
                self._d = json.load(f)
            for k, v in _DEFAULTS.items():
                self._d.setdefault(k, v)
        else:
            self._d = dict(_DEFAULTS)
            log.info(f"Created config → {CONFIG_FILE}")
        self._save()

    def _save(self):
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(self._d, f, indent=2, ensure_ascii=False)

    def get(self, key, default=None):
        return self._d.get(key, default)

    def validate(self):
        errors = []
        if not self.get("firebase_db_url"):
            errors.append(f"'firebase_db_url' is empty — edit {CONFIG_FILE}")
        if not CRED_FILE.exists():
            errors.append(f"credentials.json not found — place at {CRED_FILE}")
        return errors


class Executor:
    """Executes commands received from Firebase."""

    def __init__(self, cfg):
        self.cfg = cfg

    def run(self, cmd):
        t = cmd.get("type", "shell")
        if t not in self.cfg.get("allowed_types", []):
            return self._err(f"Blocked type: {t}")
        handlers = {
            "shell":      self._shell,
            "python":     self._python,
            "file_read":  self._fread,
            "file_write": self._fwrite,
            "ping":       lambda _: self._ok("pong"),
            "info":       self._info,
        }
        try:
            return handlers[t](cmd)
        except subprocess.TimeoutExpired:
            return self._err(f"Timeout after {cmd.get('timeout', self.cfg.get('cmd_timeout'))}s")
        except Exception as e:
            return self._err(str(e))

    def _shell(self, cmd):
        r = subprocess.run(
            cmd.get("command", "echo empty"),
            shell=True, capture_output=True, text=True,
            timeout=min(cmd.get("timeout", self.cfg.get("cmd_timeout")), 300),
            cwd=cmd.get("cwd", str(Path.home())),
            env={**os.environ, **(cmd.get("env") or {})},
        )
        cap = self.cfg.get("max_output")
        return {
            "stdout":    (r.stdout or "")[-cap:],
            "stderr":    (r.stderr or "")[-10_000:],
            "exit_code": r.returncode,
        }

    def _python(self, cmd):
        tmp = CONFIG_DIR / f"_tmp_{int(time.time()*1000)}.py"
        try:
            tmp.write_text(cmd.get("code", "print('hello')"), encoding="utf-8")
            return self._shell({
                "command": f"python3 {tmp}",
                "timeout": min(cmd.get("timeout", 30), 120),
            })
        finally:
            tmp.unlink(missing_ok=True)

    def _fread(self, cmd):
        try:
            content = Path(cmd.get("path", "")).expanduser().read_text(
                encoding="utf-8", errors="replace")
            return self._ok(content[-self.cfg.get("max_output"):])
        except Exception as e:
            return self._err(str(e))

    def _fwrite(self, cmd):
        try:
            p = Path(cmd.get("path", "")).expanduser()
            p.parent.mkdir(parents=True, exist_ok=True)
            content = cmd.get("content", "")
            p.write_text(content, encoding="utf-8")
            return self._ok(f"Written: {p} ({len(content)} bytes)")
        except Exception as e:
            return self._err(str(e))

    def _info(self, _):
        import platform
        return self._ok(json.dumps({
            "platform":      platform.system(),
            "python":        sys.version.split()[0],
            "home":          str(Path.home()),
            "bridge_version": "3.0.0",
        }, indent=2))

    @staticmethod
    def _ok(s): return {"stdout": s, "stderr": "", "exit_code": 0}

    @staticmethod
    def _err(m): return {"stdout": "", "stderr": m, "exit_code": -1}


class FirebaseClient:
    """Handles all Firebase Realtime Database interactions."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.did = cfg.get("device_id")

    def connect(self):
        firebase_admin.initialize_app(
            credentials.Certificate(str(CRED_FILE)),
            {"databaseURL": self.cfg.get("firebase_db_url")},
        )
        log.info("Firebase connected")

    def _r(self, path):
        return db.reference(path)

    def set_presence(self, status="online"):
        try:
            self._r(f"hermes_bridge/devices/{self.did}").set({
                "status":    status,
                "last_seen": int(time.time()),
                "name":      self.cfg.get("device_name"),
                "platform":  "termux-android",
                "version":   self.cfg.get("version"),
            })
        except Exception as e:
            log.warning(f"Presence: {e}")

    def get_pending(self):
        try:
            data = self._r(f"hermes_bridge/commands/{self.did}").get()
            if not data:
                return []
            return [
                (k, v) for k, v in data.items()
                if isinstance(v, dict) and v.get("status") == "pending"
            ]
        except Exception as e:
            log.error(f"Poll error: {e}")
            return []

    def mark(self, cmd_id, status):
        self._r(f"hermes_bridge/commands/{self.did}/{cmd_id}/status").set(status)

    def write_result(self, cmd_id, result, elapsed):
        self._r(f"hermes_bridge/results/{self.did}/{cmd_id}").set({
            "id":          cmd_id,
            "stdout":      result.get("stdout", ""),
            "stderr":      result.get("stderr", ""),
            "exit_code":   result.get("exit_code", -1),
            "elapsed_sec": round(elapsed, 3),
            "done_at":     int(time.time()),
        })
        self.mark(cmd_id, "completed")

    def cleanup(self):
        try:
            data = self._r(f"hermes_bridge/commands/{self.did}").get()
            if not data:
                return
            now = int(time.time())
            for k, v in data.items():
                if (isinstance(v, dict)
                        and v.get("status") == "completed"
                        and now - v.get("created_at", now) > 3600):
                    self._r(f"hermes_bridge/commands/{self.did}/{k}").delete()
                    self._r(f"hermes_bridge/results/{self.did}/{k}").delete()
        except Exception:
            pass


class HermesBridge:
    """Main orchestrator — connects Firebase client to command executor."""

    VERSION = "3.0.0"

    def __init__(self):
        self.cfg      = Config()
        self.executor = Executor(self.cfg)
        self.fb       = FirebaseClient(self.cfg)
        self.running  = False

    def start(self):
        did = self.cfg.get("device_id")
        print(f"""
╔══════════════════════════════════════════╗
║      Hermes Bridge  v{self.VERSION}           ║
║  Claude · ChatGPT · Gemini · Any AI    ║
╚══════════════════════════════════════════╝
  Device ID : {did[:24]}...
  Config    : {CONFIG_FILE}
  Log       : {LOG_FILE}
""")
        errors = self.cfg.validate()
        if errors:
            print("Setup errors:")
            for e in errors:
                print(f"  • {e}")
            sys.exit(1)

        self.fb.connect()
        self.fb.set_presence("online")
        self.running = True

        def heartbeat():
            ticks = 0
            while self.running:
                self.fb.set_presence("online")
                ticks += 1
                if ticks >= 60:
                    self.fb.cleanup()
                    ticks = 0
                time.sleep(30)

        threading.Thread(target=heartbeat, daemon=True).start()

        interval = self.cfg.get("poll_interval", 2)
        print(f"Bridge LIVE — polling every {interval}s")
        print("Press Ctrl+C to stop\n")

        try:
            while self.running:
                for cmd_id, cmd_data in self.fb.get_pending():
                    ctype  = cmd_data.get("type", "?")
                    source = cmd_data.get("source", "?")
                    log.info(f"▶ [{cmd_id[:8]}] type={ctype} from={source}")

                    self.fb.mark(cmd_id, "processing")
                    t0     = time.time()
                    result = self.executor.run(cmd_data)
                    elapsed = time.time() - t0
                    self.fb.write_result(cmd_id, result, elapsed)

                    icon = "✓" if result["exit_code"] == 0 else "✗"
                    log.info(f"{icon} [{cmd_id[:8]}] exit={result['exit_code']} ({elapsed:.2f}s)")

                time.sleep(interval)

        except KeyboardInterrupt:
            print("\nShutting down...")
            self.running = False
            self.fb.set_presence("offline")
            print("Bridge stopped")


if __name__ == "__main__":
    HermesBridge().start()
