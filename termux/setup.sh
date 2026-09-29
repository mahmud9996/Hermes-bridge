#!/data/data/com.termux/files/usr/bin/bash
set -e
BRIDGE_DIR="$HOME/hermes-bridge"; CONFIG_DIR="$HOME/.hermes-bridge"
mkdir -p "$BRIDGE_DIR" "$CONFIG_DIR"
echo "[1/5] Installing system packages..."
pkg update -y -q 2>/dev/null || true; pkg install -y python python-pip openssl-tool curl 2>/dev/null
echo "[2/5] Installing Python packages..."
pip install --quiet firebase-admin requests
echo "[3/5] Copying hermes_bridge.py..."
[ -f "$(dirname "$0")/hermes_bridge.py" ] && cp "$(dirname "$0")/hermes_bridge.py" "$BRIDGE_DIR/" || echo "      Copy hermes_bridge.py manually to $BRIDGE_DIR/"
echo "[4/5] Creating management scripts..."
cat > "$BRIDGE_DIR/start.sh" << 'S'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock 2>/dev/null || true
cd ~/hermes-bridge && python3 hermes_bridge.py
S
cat > "$BRIDGE_DIR/start-bg.sh" << 'S'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock 2>/dev/null || true
cd ~/hermes-bridge
nohup python3 hermes_bridge.py >> ~/.hermes-bridge/bridge.log 2>&1 &
echo "$!" > ~/.hermes-bridge/bridge.pid
echo "Bridge started (PID: $!)"
S
cat > "$BRIDGE_DIR/stop.sh" << 'S'
#!/data/data/com.termux/files/usr/bin/bash
PID_FILE="$HOME/.hermes-bridge/bridge.pid"
if [ -f "$PID_FILE" ]; then kill $(cat "$PID_FILE") 2>/dev/null && echo "Stopped" || echo "Not running"; rm -f "$PID_FILE"
else pkill -f hermes_bridge.py && echo "Stopped" || echo "Not running"; fi
S
chmod +x "$BRIDGE_DIR/start.sh" "$BRIDGE_DIR/start-bg.sh" "$BRIDGE_DIR/stop.sh"
echo "[5/5] Initializing config..."
cd "$BRIDGE_DIR" && python3 -c "
import sys; sys.path.insert(0,'.')
from hermes_bridge import Config, CONFIG_FILE
cfg = Config()
print(f'  Config    : {CONFIG_FILE}')
print(f'  Device ID : {cfg.get(\"device_id\")}')
print('  IMPORTANT: Copy this Device ID to Cloudflare DEVICE_ID variable')
" 2>/dev/null || true
echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. cp /sdcard/Download/credentials.json ~/.hermes-bridge/credentials.json"
echo "  2. nano ~/.hermes-bridge/config.json  — set firebase_db_url"
echo "  3. cd ~/hermes-bridge && ./start.sh"
