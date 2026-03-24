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

function savePreset() {
  writeFileSync(PRESET_PATH, JSON.stringify(allowedTools, null, 2) + "\n");
}

function buildPattern(denial) {
  const tool = denial.toolName;
  const input = denial.input;

  if (!tool || !input) {
    return denial.text ? guessPatternFromDenial(denial.text) : (tool || "unknown");
  }

  // Bash: extract first word of command as prefix
  if (tool === "Bash" && input.command) {
    const firstWord = input.command.trim().split(/[\s;|&]/)[0];
    return `Bash(${firstWord}:*)`;
  }

  // File tools: extract parent directory
  if (["Write", "Edit", "Read"].includes(tool) && input.file_path) {
    const dir = input.file_path.replace(/\/[^/]+$/, "");
    return `${tool}(${dir}:*)`;
  }

  return tool;
}

function guessToolFromDenial(denial) {
  if (denial.includes("write to") || denial.includes("create")) return "Write";
  if (denial.includes("edit")) return "Edit";
  if (denial.includes("read")) return "Read";
  if (denial.includes("execute") || denial.includes("run")) return "Bash";
  if (denial.includes("search")) return "WebSearch";
  if (denial.includes("fetch")) return "WebFetch";
  // Fallback: try to extract tool name directly
  const m = denial.match(/use (\w+)/);
  return m ? m[1] : "unknown";
}

function guessPatternFromDenial(denial) {
  const tool = guessToolFromDenial(denial);

  // Try to extract path for file tools
  if (["Write", "Edit", "Read"].includes(tool)) {
    const pathMatch = denial.match(/(?:write to|edit|read)\s+(\/\S+)/i);
    if (pathMatch) {
      // Use parent directory as pattern: Write(/stuff/baiwan/dev/foo:*)
      const dir = pathMatch[1].replace(/\/[^/]+$/, "");
      return `${tool}(${dir}:*)`;
    }
  }

  // Try to extract command prefix for Bash
  if (tool === "Bash") {
    const cmdMatch = denial.match(/run\s+`([^`\s]+)/i)
      || denial.match(/execute\s+`([^`\s]+)/i);
    if (cmdMatch) {
      return `Bash(${cmdMatch[1]}:*)`;
    }
  }

  // Fallback to just the tool name
  return tool;
}

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

// Per-session auto-allow (in addition to preset)
// Persisted in sessions.json as session.autoAllowed array
const sessionAutoAllowed = new Map(); // sessionName -> Set of tool names

// Load persisted per-session auto-allows
for (const s of sessions) {
  if (Array.isArray(s.autoAllowed) && s.autoAllowed.length) {
    sessionAutoAllowed.set(s.name, new Set(s.autoAllowed));
  }
}

function saveSessionAutoAllowed(sessionName) {
  const session = sessions.find(s => s.name === sessionName);
  if (session) {
    const extra = sessionAutoAllowed.get(sessionName);
    session.autoAllowed = extra ? [...extra] : [];
    saveSessions();
  }
}

function getEffectiveAllowedTools(sessionName) {
  const extra = sessionAutoAllowed.get(sessionName);
  if (!extra?.size) return allowedTools;
  return [...allowedTools, ...extra];
}

function runClaude(session, message) {
  return new Promise((resolve, reject) => {
    const effective = getEffectiveAllowedTools(session.name);
    const args = ["-p", message, "--output-format", "stream-json", "--verbose"];

    // Resume conversation if we have a session ID
    if (session.sessionId) {
      args.push("--resume", session.sessionId);
    }

    // Permission mode — auto-allow tools from preset + session extras
    if (effective.length) {
      args.push("--allowedTools", ...effective);
      args.push("--permission-mode", "auto");
    }

    const proc = spawn("claude", args, {
      cwd: session.workDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcs.set(session.name, proc);

    let buffer = "";
    let resultText = "";
    let sessionId = null;
    const permissionDenials = [];

    proc.stdout.on("data", (d) => {
      buffer += d;
      // Parse newline-delimited JSON
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Extract session ID from init
          if (event.type === "system" && event.subtype === "init") {
            sessionId = event.session_id;
          }

          // Extract session ID and permission denials from result
          if (event.type === "result") {
            sessionId = event.session_id || sessionId;
            resultText = event.result || resultText;
            // Structured permission denials from result event
            if (Array.isArray(event.permission_denials)) {
              for (const d of event.permission_denials) {
                permissionDenials.push({
                  toolName: d.tool_name,
                  input: d.tool_input,
                  text: `${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 200)}`,
                });
              }
            }
          }

          // Extract text from assistant messages
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") {
                resultText = block.text;
              }
            }
          }

          // Legacy text-based denial detection (fallback)
          if (event.type === "user" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.is_error && typeof block.content === "string"
                  && (block.content.includes("requested permissions")
                    || block.content.includes("was blocked")
                    || block.content.includes("haven't granted"))) {
                // Only add if we don't already have a structured denial for this
                const toolName = guessToolFromDenial(block.content);
                if (!permissionDenials.some(d => d.toolName === toolName)) {
                  permissionDenials.push({ toolName, text: block.content });
                }
              }
            }
          }
        } catch { /* skip unparseable lines */ }
      }
    });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("close", (code) => {
      activeProcs.delete(session.name);

      if (code === 0 || resultText) {
        resolve({
          response: resultText || "(empty response)",
          sessionId,
          permissionDenials,
        });
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

// Pending permission messages: messageId -> { sessionName, toolName }
const pendingPermissions = new Map();

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

      sessionAutoAllowed.delete(name);
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
        `${API}/getUpdates?offset=${pollOffset}&timeout=30&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "message_reaction"]))}`,
        { signal: AbortSignal.timeout(35000) }
      );
      const data = await res.json();
      const updates = data.ok ? data.result : [];

      if (updates.length) console.error(`Got ${updates.length} update(s)`);

      for (const update of updates) {
        pollOffset = update.update_id + 1;
        console.error(`Update: ${JSON.stringify(update).slice(0, 200)}`);

        // --- Handle emoji reactions (auto-allow permissions) ---
        const reaction = update.message_reaction;
        if (reaction) {
          if (reaction.user?.id !== ALLOWED_USER_ID) continue;
          if (reaction.chat.id !== CONTROL_CHAT_ID) continue;
          const entry = pendingPermissions.get(reaction.message_id);
          if (!entry) continue;

          const emojis = (reaction.new_reaction || []).map(r => r.emoji);
          if (emojis.includes("👍")) {
            // Add exact tool to session auto-allow
            if (!sessionAutoAllowed.has(entry.sessionName)) {
              sessionAutoAllowed.set(entry.sessionName, new Set());
            }
            sessionAutoAllowed.get(entry.sessionName).add(entry.toolName);
            saveSessionAutoAllowed(entry.sessionName);
            pendingPermissions.delete(reaction.message_id);
            await tgSend(CONTROL_CHAT_ID,
              `✅ \`${entry.toolName}\` auto-allowed for session *${entry.sessionName}*.`,
              reaction.message_thread_id);
          } else if (emojis.includes("❤️")) {
            // Add pattern to session auto-allow (allow similar)
            if (!sessionAutoAllowed.has(entry.sessionName)) {
              sessionAutoAllowed.set(entry.sessionName, new Set());
            }
            sessionAutoAllowed.get(entry.sessionName).add(entry.pattern);
            saveSessionAutoAllowed(entry.sessionName);
            pendingPermissions.delete(reaction.message_id);
            await tgSend(CONTROL_CHAT_ID,
              `✅ Pattern \`${entry.pattern}\` auto-allowed for session *${entry.sessionName}*.`,
              reaction.message_thread_id);
          } else if (emojis.includes("🤖")) {
            // Add pattern to global preset (allow similar, persistent)
            if (!allowedTools.includes(entry.pattern)) {
              allowedTools.push(entry.pattern);
              savePreset();
            }
            pendingPermissions.delete(reaction.message_id);
            await tgSend(CONTROL_CHAT_ID,
              `✅ Pattern \`${entry.pattern}\` added to global preset.`,
              reaction.message_thread_id);
          }
          continue;
        }

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

          // Report permission denials so user can auto-allow
          for (const denial of result.permissionDenials) {
            const toolName = denial.toolName || guessToolFromDenial(denial.text || "");
            const pattern = buildPattern(denial);
            const preview = denial.text || `${toolName} was denied`;
            const msgId = await tgSend(CONTROL_CHAT_ID,
              `⚠️ *Permission denied:* ${preview}\n\n` +
              `👍 auto-allow \`${toolName}\` (this session)\n` +
              `❤️ allow similar: \`${pattern}\` (this session)\n` +
              `🤖 allow similar: \`${pattern}\` (global preset)`,
              topicId);
            if (msgId && toolName) {
              pendingPermissions.set(msgId, { sessionName: session.name, toolName, pattern });
            }
          }
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
