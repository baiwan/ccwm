#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config -----------------------------------------------------------------
const BOT_TOKEN = process.env.TELEGRAM_SESSION_BOT_TOKEN;
if (!BOT_TOKEN) { console.error("TELEGRAM_SESSION_BOT_TOKEN is required"); process.exit(1); }

const ALLOWED_USER_ID = Number(process.env.TELEGRAM_USER_ID);
if (!ALLOWED_USER_ID) { console.error("TELEGRAM_USER_ID is required"); process.exit(1); }

const CONTROL_CHAT_ID = Number(process.env.TELEGRAM_CONTROL_CHAT_ID);
if (!CONTROL_CHAT_ID) { console.error("TELEGRAM_CONTROL_CHAT_ID is required (supergroup with topics)"); process.exit(1); }

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SESSIONS_PATH = resolve(__dirname, "sessions.json");
const PRESET_PATH = resolve(__dirname, "auto-allow-preset.json");

let pollOffset = 0;

// --- Session state ----------------------------------------------------------
// Each session: { name, topicId, workDir, sessionId }
let sessions = [];

function loadSessions() {
  try {
    sessions = JSON.parse(readFileSync(SESSIONS_PATH, "utf8"));
  } catch { sessions = []; }
}

function saveSessions() {
  writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2) + "\n");
}

loadSessions();

// --- Auto-allow preset (loaded into claude via --allowedTools) --------------
let allowedTools = [];
try {
  const preset = JSON.parse(readFileSync(PRESET_PATH, "utf8"));
  if (Array.isArray(preset)) allowedTools = preset;
} catch { /* no preset */ }

// --- Telegram helpers -------------------------------------------------------
async function tgApi(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tgSend(chatId, text, topicId) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4096) {
    chunks.push(text.slice(i, i + 4096));
  }
  let lastMessageId = null;
  for (const chunk of chunks) {
    const body = { chat_id: chatId, text: chunk, parse_mode: "Markdown" };
    if (topicId) body.message_thread_id = topicId;
    const json = await tgApi("sendMessage", body);
    if (!json.ok) {
      delete body.parse_mode;
      const json2 = await tgApi("sendMessage", body);
      if (json2.ok) lastMessageId = json2.result.message_id;
    } else {
      lastMessageId = json.result.message_id;
    }
  }
  return lastMessageId;
}

async function tgTyping(chatId, topicId) {
  const body = { chat_id: chatId, action: "typing" };
  if (topicId) body.message_thread_id = topicId;
  await tgApi("sendChatAction", body).catch(() => {});
}

// --- Claude Code interaction ------------------------------------------------
// Active child processes per session name (for cancellation)
const activeProcs = new Map();

function runClaude(session, message) {
  return new Promise((resolve, reject) => {
    const args = ["-p", message, "--output-format", "text", "--verbose"];

    // Resume conversation if we have a session ID
    if (session.sessionId) {
      args.push("--resume", session.sessionId);
    }

    // Permission mode — auto-allow tools from preset
    if (allowedTools.length) {
      args.push("--allowedTools", ...allowedTools);
      args.push("--permission-mode", "auto");
    }

    const proc = spawn("claude", args, {
      cwd: session.workDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcs.set(session.name, proc);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("close", (code) => {
      activeProcs.delete(session.name);

      // Try to extract session ID from stderr (claude prints it there)
      const sidMatch = stderr.match(/session:\s*([0-9a-f-]{36})/i)
        || stderr.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const newSessionId = sidMatch ? sidMatch[1] : null;

      if (code === 0 || stdout.trim()) {
        resolve({ response: stdout.trim() || "(empty response)", sessionId: newSessionId });
      } else {
        reject(new Error(`claude exited ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on("error", (err) => {
      activeProcs.delete(session.name);
      reject(err);
    });
  });
}

// --- Typing indicator loop --------------------------------------------------
// Keeps sending "typing" every 4s while claude is working
function startTypingLoop(chatId, topicId, sessionName) {
  const iv = setInterval(() => {
    if (!activeProcs.has(sessionName)) {
      clearInterval(iv);
      return;
    }
    tgTyping(chatId, topicId);
  }, 4000);
  // Also send immediately
  tgTyping(chatId, topicId);
  return iv;
}

// --- Command handling (General topic) ---------------------------------------
async function handleCommand(chatId, topicId, command, args) {
  switch (command) {
    case "create": {
      const match = args.match(/^(\S+)\s+(.+)$/);
      if (!match) {
        await tgSend(chatId, "Usage: `/create <name> <working_dir>`", topicId);
        return;
      }
      const [, name, rawDir] = match;

      if (sessions.find(s => s.name === name)) {
        await tgSend(chatId, `Session "${name}" already exists.`, topicId);
        return;
      }

      const absDir = resolve(rawDir.trim());
      if (!existsSync(absDir)) {
        mkdirSync(absDir, { recursive: true });
      }

      let newTopicId;
      try {
        const res = await tgApi("createForumTopic", {
          chat_id: chatId,
          name: `🤖 ${name}`,
        });
        if (!res.ok) throw new Error(JSON.stringify(res));
        newTopicId = res.result.message_thread_id;
      } catch (err) {
        await tgSend(chatId, `❌ Failed to create topic: ${err.message}`, topicId);
        return;
      }

      sessions.push({ name, topicId: newTopicId, workDir: absDir, sessionId: null });
      saveSessions();

      await tgSend(chatId, `✅ Session *${name}* created.\nDir: \`${absDir}\`\nSend messages in the new topic.`, topicId);
      await tgSend(chatId, `Session *${name}* ready. Working directory: \`${absDir}\``, newTopicId);
      break;
    }

    case "list": {
      if (!sessions.length) {
        await tgSend(chatId, "No active sessions.", topicId);
        return;
      }
      const list = sessions.map(s =>
        `• *${s.name}* — \`${s.workDir}\`${s.sessionId ? " (has history)" : ""}`
      ).join("\n");
      await tgSend(chatId, `Active sessions:\n${list}`, topicId);
      break;
    }

    case "remove": {
      const name = args.trim();
      const idx = sessions.findIndex(s => s.name === name);
      if (idx === -1) {
        await tgSend(chatId, `Session "${name}" not found.`, topicId);
        return;
      }

      // Kill active process if any
      const proc = activeProcs.get(name);
      if (proc) proc.kill();

      try {
        await tgApi("deleteForumTopic", {
          chat_id: chatId,
          message_thread_id: sessions[idx].topicId,
        });
      } catch { /* topic might already be gone */ }

      sessions.splice(idx, 1);
      saveSessions();
      await tgSend(chatId, `✅ Session "${name}" removed.`, topicId);
      break;
    }

    case "help": {
      await tgSend(chatId, [
        "*Session Manager Commands:*",
        "`/create <name> <dir>` — create a new session",
        "`/list` — list active sessions",
        "`/remove <name>` — remove a session",
        "`/help` — show this message",
      ].join("\n"), topicId);
      break;
    }

    default:
      // Not a known command — ignore (don't forward to claude)
      break;
  }
}

// --- Poll and route ---------------------------------------------------------
const CMD_RE = /^\/(\w+)(?:\s+(.*))?$/s;

async function poll() {
  console.error(`Session manager started. Control chat: ${CONTROL_CHAT_ID}`);
  console.error(`Loaded ${sessions.length} session(s), ${allowedTools.length} auto-allowed tool(s).`);

  while (true) {
    try {
      const res = await fetch(
        `${API}/getUpdates?offset=${pollOffset}&timeout=30&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`,
        { signal: AbortSignal.timeout(35000) }
      );
      const data = await res.json();
      const updates = data.ok ? data.result : [];

      for (const update of updates) {
        pollOffset = update.update_id + 1;

        const msg = update.message;
        if (!msg?.text) continue;
        if (msg.from.id !== ALLOWED_USER_ID) continue;
        if (msg.chat.id !== CONTROL_CHAT_ID) continue;

        const topicId = msg.message_thread_id || null;
        const text = msg.text.trim();

        // --- General topic: handle commands ---
        const isGeneral = !topicId || topicId === 1;
        if (isGeneral) {
          const cmdMatch = CMD_RE.exec(text);
          if (cmdMatch) {
            await handleCommand(CONTROL_CHAT_ID, topicId, cmdMatch[1], cmdMatch[2] || "");
          }
          continue;
        }

        // --- Session topic: route to claude ---
        const session = sessions.find(s => s.topicId === topicId);
        if (!session) continue;

        // Check if already processing
        if (activeProcs.has(session.name)) {
          await tgSend(CONTROL_CHAT_ID, "⏳ Still processing previous message...", topicId);
          continue;
        }

        const typingIv = startTypingLoop(CONTROL_CHAT_ID, topicId, session.name);

        try {
          const result = await runClaude(session, text);

          // Persist session ID for conversation continuity
          if (result.sessionId && !session.sessionId) {
            session.sessionId = result.sessionId;
            saveSessions();
          }

          await tgSend(CONTROL_CHAT_ID, result.response, topicId);
        } catch (err) {
          await tgSend(CONTROL_CHAT_ID, `❌ ${err.message}`, topicId);
        } finally {
          clearInterval(typingIv);
        }
      }
    } catch (err) {
      console.error("Poll error:", err.message);
    }
  }
}

poll();
