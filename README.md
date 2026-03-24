# CCWM - Claude Code Workstation Manager

Control multiple Claude Code sessions remotely through Telegram.

CCWM creates isolated Claude Code workspaces, each mapped to a Telegram forum topic. Send messages in a topic, get Claude's response back — with full conversation continuity.

```
You (Telegram)  -->  CCWM Bot  -->  Claude Code (per-session)
    topic A                          /project-alpha
    topic B                          /project-beta
    topic C                          /home/scripts
```

## Requirements

- **Node.js** >= 18
- **Claude Code CLI** (`claude`) installed and authenticated
- **Telegram Bot** with a supergroup that has topics enabled

## Quick Start

```bash
git clone https://github.com/YOUR_USER/ccwm.git
cd ccwm
./install.sh
```

The install script will walk you through setup interactively.

Or do it manually:

```bash
npm install
cp .env.example .env
# Edit .env with your values (see Configuration below)
npm start
```

## Configuration

Create a `.env` file with these three values:

| Variable | What it is |
|---|---|
| `TELEGRAM_SESSION_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_USER_ID` | Your numeric Telegram user ID (get it from [@userinfobot](https://t.me/userinfobot)) |
| `TELEGRAM_CONTROL_CHAT_ID` | ID of your supergroup with topics enabled |

### Setting up Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather) — save the token
2. Create a supergroup, enable **Topics** in group settings
3. Add your bot to the group as admin
4. Get the group's chat ID (send a message, then check `https://api.telegram.org/bot<TOKEN>/getUpdates`)

## Usage

All commands are sent in the **General** topic of your control chat:

| Command | Description |
|---|---|
| `/create <name> <directory>` | Create a new session with a working directory |
| `/list` | Show all active sessions |
| `/remove <name>` | Remove a session and its topic |
| `/help` | Show available commands |

**Example workflow:**

```
/create myapp /home/user/projects/myapp
```

This creates a new topic called "myapp". Switch to that topic and start chatting with Claude — it works in `/home/user/projects/myapp` and remembers the conversation.

## Auto-Allowed Tools

Sessions auto-allow these Claude Code tools (configurable in `auto-allow-preset.json`):

`Edit` `Write` `Read` `Glob` `Grep` `WebFetch` `WebSearch`

## Running as a Service

To keep CCWM running in the background:

```bash
# Using screen
screen -S ccwm
npm start
# Ctrl+A, D to detach

# Using systemd (see install script for setup)
sudo systemctl start ccwm
sudo systemctl enable ccwm
```

## License

MIT
