#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

header() {
    echo ""
    echo -e "${CYAN}${BOLD}"
    echo "   ██████╗ ██████╗██╗    ██╗███╗   ███╗"
    echo "  ██╔════╝██╔════╝██║    ██║████╗ ████║"
    echo "  ██║     ██║     ██║ █╗ ██║██╔████╔██║"
    echo "  ██║     ██║     ██║███╗██║██║╚██╔╝██║"
    echo "  ╚██████╗╚██████╗╚███╔███╔╝██║ ╚═╝ ██║"
    echo "   ╚═════╝ ╚═════╝ ╚══╝╚══╝ ╚═╝     ╚═╝"
    echo -e "${RESET}"
    echo -e "  ${DIM}Claude Code Workstation Manager${RESET}"
    echo ""
}

info()    { echo -e "  ${CYAN}>${RESET} $1"; }
success() { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}!${RESET} $1"; }
fail()    { echo -e "  ${RED}✗${RESET} $1"; exit 1; }
ask()     { echo -en "  ${CYAN}?${RESET} $1"; }

divider() { echo -e "  ${DIM}─────────────────────────────────────────${RESET}"; }

# ─── Start ──────────────────────────────────────────
header

echo -e "  ${BOLD}Checking dependencies...${RESET}"
echo ""

# Check Node.js
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
    if [ "$NODE_MAJOR" -ge 18 ]; then
        success "Node.js $NODE_VER"
    else
        fail "Node.js >= 18 required (found $NODE_VER)"
    fi
else
    fail "Node.js not found. Install it from https://nodejs.org"
fi

# Check Claude Code
if command -v claude &>/dev/null; then
    success "Claude Code CLI found"
else
    warn "Claude Code CLI not found in PATH"
    warn "Install it: npm install -g @anthropic-ai/claude-code"
    echo ""
    ask "Continue anyway? [y/N] "
    read -r answer
    [[ "$answer" =~ ^[Yy]$ ]] || exit 1
fi

divider
echo ""

# ─── Install npm packages ──────────────────────────
info "Installing npm packages..."
cd "$SCRIPT_DIR"
npm install --silent 2>/dev/null
success "Dependencies installed"
echo ""

divider
echo ""

# ─── Configure .env ─────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
    success ".env file exists"
    ask "Reconfigure? [y/N] "
    read -r answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        echo ""
        divider
        echo ""
        goto_run=true
    fi
fi

if [ "${goto_run:-}" != "true" ]; then
    echo -e "  ${BOLD}Telegram Setup${RESET}"
    echo -e "  ${DIM}You'll need: a bot token, your user ID, and a supergroup ID${RESET}"
    echo ""

    ask "Bot token (from @BotFather): "
    read -r bot_token
    echo ""

    ask "Your Telegram user ID (from @userinfobot): "
    read -r user_id
    echo ""

    ask "Supergroup chat ID (with topics enabled): "
    read -r chat_id
    echo ""

    cat > "$SCRIPT_DIR/.env" <<EOF
TELEGRAM_SESSION_BOT_TOKEN=$bot_token
TELEGRAM_USER_ID=$user_id
TELEGRAM_CONTROL_CHAT_ID=$chat_id
EOF

    success "Configuration saved to .env"
    echo ""
    divider
    echo ""
fi

# ─── Optional: systemd service ─────────────────────
echo -e "  ${BOLD}Background Service (optional)${RESET}"
echo -e "  ${DIM}Set up a systemd service to run CCWM automatically${RESET}"
echo ""
ask "Create systemd service? [y/N] "
read -r answer

if [[ "$answer" =~ ^[Yy]$ ]]; then
    SERVICE_FILE="/etc/systemd/system/ccwm.service"
    NODE_PATH=$(which node)

    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=CCWM - Claude Code Workstation Manager
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_PATH $SCRIPT_DIR/session-manager.mjs
Restart=on-failure
RestartSec=5
EnvironmentFile=$SCRIPT_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    success "Service created at $SERVICE_FILE"
    echo ""
    ask "Start it now? [y/N] "
    read -r start_now
    if [[ "$start_now" =~ ^[Yy]$ ]]; then
        sudo systemctl start ccwm
        sudo systemctl enable ccwm --quiet
        success "CCWM is running and enabled on boot"
    else
        info "Start later with: sudo systemctl start ccwm"
    fi
else
    info "Skipped. You can run manually with: npm start"
fi

echo ""
divider
echo ""
echo -e "  ${GREEN}${BOLD}Setup complete!${RESET}"
echo ""
echo -e "  ${DIM}Quick start:${RESET}"
echo -e "    cd $SCRIPT_DIR"
echo -e "    npm start"
echo ""
echo -e "  ${DIM}Then in Telegram, send:${RESET}"
echo -e "    /create myproject /path/to/code"
echo ""
