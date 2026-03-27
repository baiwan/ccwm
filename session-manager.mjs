#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
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

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff"]);

async function tgSendPhoto(chatId, filePath, topicId, caption) {
  const { createReadStream } = await import("node:fs");
  const FormData = (await import("node:buffer")).File ? null : null; // node 18+ has global FormData
  const form = new globalThis.FormData();
  const blob = new Blob([readFileSync(filePath)]);
  const filename = filePath.split("/").pop();
  form.append("chat_id", String(chatId));
  form.append("photo", blob, filename);
  if (topicId) form.append("message_thread_id", String(topicId));
  if (caption) form.append("caption", caption.slice(0, 1024));
  const res = await fetch(`${API}/sendPhoto`, { method: "POST", body: form });
  return res.json();
}

async function tgTyping(chatId, topicId) {
  const body = { chat_id: chatId, action: "typing" };
  if (topicId) body.message_thread_id = topicId;
  await tgApi("sendChatAction", body).catch(() => {});
}

// Download a Telegram file to a local path. Returns the local file path.
async function downloadTgFile(fileId, destDir, filename) {
  const fileInfo = await tgApi("getFile", { file_id: fileId });
  if (!fileInfo.ok) throw new Error(`getFile failed: ${JSON.stringify(fileInfo)}`);
  const filePath = fileInfo.result.file_path;
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = filePath.includes(".") ? "." + filePath.split(".").pop() : "";
  const localName = filename + ext;
  const mediaDir = join(destDir, ".ccwm-media");
  if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
  const localPath = join(mediaDir, localName);
  await writeFile(localPath, buf);
  return localPath;
}

// Extract media from a Telegram message. Returns { text, files[] } or null.
async function extractMedia(msg, destDir) {
  const files = [];
  const ts = Date.now();

  if (msg.photo?.length) {
    // Telegram sends multiple sizes; pick the largest
    const photo = msg.photo[msg.photo.length - 1];
    const path = await downloadTgFile(photo.file_id, destDir, `photo_${ts}`);
    files.push({ type: "image", path });
  }

  if (msg.voice) {
    const path = await downloadTgFile(msg.voice.file_id, destDir, `voice_${ts}`);
    files.push({ type: "voice", path, duration: msg.voice.duration });
  }

  if (msg.audio) {
    const path = await downloadTgFile(msg.audio.file_id, destDir, `audio_${ts}`);
    files.push({ type: "audio", path, title: msg.audio.title });
  }

  if (msg.video) {
    const path = await downloadTgFile(msg.video.file_id, destDir, `video_${ts}`);
    files.push({ type: "video", path, duration: msg.video.duration });
  }

  if (msg.video_note) {
    const path = await downloadTgFile(msg.video_note.file_id, destDir, `videonote_${ts}`);
    files.push({ type: "video_note", path, duration: msg.video_note.duration });
  }

  if (msg.document && !msg.document.mime_type?.startsWith("video/")) {
    const path = await downloadTgFile(msg.document.file_id, destDir, `doc_${ts}_${msg.document.file_name || "file"}`);
    files.push({ type: "document", path, name: msg.document.file_name });
  }

  if (!files.length) return null;

  // Build prompt: caption/text + file references
  const caption = msg.caption || msg.text || "";
  const parts = [];
  if (caption) parts.push(caption);
  for (const f of files) {
    if (f.type === "image") {
      parts.push(`[Image attached — read it at: ${f.path}]`);
    } else if (f.type === "voice") {
      parts.push(`[Voice message (${f.duration}s) saved to: ${f.path} — this is an OGG audio file]`);
    } else if (f.type === "audio") {
      parts.push(`[Audio file "${f.title || ""}" saved to: ${f.path}]`);
    } else if (f.type === "video" || f.type === "video_note") {
      parts.push(`[Video (${f.duration}s) saved to: ${f.path}]`);
    } else {
      parts.push(`[File "${f.name || ""}" saved to: ${f.path}]`);
    }
  }
  return { text: parts.join("\n"), files };
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

function runClaude(session, message, { onThinking, onToolUse, onToolResult } = {}) {
  return new Promise((resolve, reject) => {
    const effective = getEffectiveAllowedTools(session.name);
    const args = ["-p", message, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];

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

    // Timeout: kill after 5 minutes and return whatever we have
    const timeout = setTimeout(() => {
      console.error(`Timeout for session "${session.name}" — killing claude process`);
      proc.kill();
    }, 5 * 60 * 1000);

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

          // Extract text and tool_use from assistant messages
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") {
                resultText += (resultText ? "\n\n" : "") + block.text;
              }
              if (block.type === "tool_use" && onToolUse) {
                onToolUse(block);
              }
            }
          }

          // Extract tool results from user messages
          if (event.type === "user" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "tool_result" && onToolResult) {
                onToolResult(block);
              }
            }
          }

          // Stream thinking from stream_event deltas
          if (event.type === "stream_event" && event.event) {
            const se = event.event;
            if (se.type === "content_block_delta" && se.delta?.type === "thinking_delta" && onThinking) {
              onThinking(se.delta.thinking);
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
      clearTimeout(timeout);
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
      clearTimeout(timeout);
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

      let newTopicId, thinkingTopicId, toolTopicId;
      try {
        const res = await tgApi("createForumTopic", {
          chat_id: chatId,
          name: `🤖 ${name}`,
        });
        if (!res.ok) throw new Error(JSON.stringify(res));
        newTopicId = res.result.message_thread_id;

        const res2 = await tgApi("createForumTopic", {
          chat_id: chatId,
          name: `🧠 ${name}`,
        });
        if (res2.ok) {
          thinkingTopicId = res2.result.message_thread_id;
        }

        const res3 = await tgApi("createForumTopic", {
          chat_id: chatId,
          name: `🔧 ${name}`,
        });
        if (res3.ok) {
          toolTopicId = res3.result.message_thread_id;
        }
      } catch (err) {
        await tgSend(chatId, `❌ Failed to create topic: ${err.message}`, topicId);
        return;
      }

      sessions.push({ name, topicId: newTopicId, thinkingTopicId: thinkingTopicId || null, toolTopicId: toolTopicId || null, workDir: absDir, sessionId: null });
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

// --- Handle a session message (runs concurrently, doesn't block poll) -------
async function handleSessionMessage(session, topicId, promptText) {
  const typingIv = startTypingLoop(CONTROL_CHAT_ID, topicId, session.name);

  try {
    console.error(`Routing to session "${session.name}" (${session.workDir}): ${promptText.slice(0, 100)}`);

    // Stream thinking to the thinking topic if it exists
    const thinkingTopicId = session.thinkingTopicId;
    let thinkingBuffer = "";
    let thinkingFlushTimer = null;

    const flushThinking = async () => {
      if (!thinkingBuffer || !thinkingTopicId) return;
      const chunk = thinkingBuffer;
      thinkingBuffer = "";
      await tgSend(CONTROL_CHAT_ID, chunk, thinkingTopicId).catch(() => {});
    };

    const onThinking = thinkingTopicId ? (text) => {
      thinkingBuffer += text;
      // Batch thinking output — flush every 2 seconds or at 3000 chars
      if (thinkingBuffer.length > 3000) {
        clearTimeout(thinkingFlushTimer);
        flushThinking();
      } else if (!thinkingFlushTimer) {
        thinkingFlushTimer = setTimeout(() => {
          thinkingFlushTimer = null;
          flushThinking();
        }, 2000);
      }
    } : undefined;

    // Stream tool activity to the tool topic if it exists
    const toolTopicId = session.toolTopicId;

    const formatToolInput = (name, input) => {
      if (!input) return "";
      if (name === "Bash" && input.command) return `\`${input.command.slice(0, 500)}\``;
      if (name === "Read" && input.file_path) return `\`${input.file_path}\`${input.offset ? ` (L${input.offset})` : ""}`;
      if (name === "Write" && input.file_path) return `\`${input.file_path}\``;
      if (name === "Edit" && input.file_path) return `\`${input.file_path}\``;
      if (name === "Glob" && input.pattern) return `\`${input.pattern}\``;
      if (name === "Grep" && input.pattern) return `\`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ""}`;
      if (name === "Agent") return input.prompt?.slice(0, 200) || "";
      return JSON.stringify(input).slice(0, 300);
    };

    // Track pending tool calls so we can detect image writes
    const pendingTools = new Map(); // tool_use_id -> block

    const onToolUse = (block) => {
      pendingTools.set(block.id, block);
      if (toolTopicId) {
        const summary = `🔧 *${block.name}*\n${formatToolInput(block.name, block.input)}`;
        tgSend(CONTROL_CHAT_ID, summary, toolTopicId).catch(() => {});
      }

      // If Write targets an image file, send it as a photo after a short delay
      if (block.name === "Write" && block.input?.file_path) {
        const ext = "." + block.input.file_path.split(".").pop().toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          // Delay to let the file be written
          setTimeout(() => {
            if (existsSync(block.input.file_path)) {
              tgSendPhoto(CONTROL_CHAT_ID, block.input.file_path, topicId, block.input.file_path.split("/").pop())
                .catch(() => {});
            }
          }, 1000);
        }
      }
    };

    const onToolResult = (block) => {
      const toolCall = pendingTools.get(block.tool_use_id);

      if (toolTopicId) {
        const content = Array.isArray(block.content)
          ? block.content.map(c => typeof c === "string" ? c : c.text || "").join("").slice(0, 1000)
          : (typeof block.content === "string" ? block.content.slice(0, 1000) : "");
        if (content) {
          const prefix = block.is_error ? "❌" : "✅";
          tgSend(CONTROL_CHAT_ID, `${prefix} ${content}`, toolTopicId).catch(() => {});
        }
      }

      // Check if a Bash command produced an image file — look for image paths in output
      if (toolCall?.name === "Bash" && !block.is_error) {
        const resultText = Array.isArray(block.content)
          ? block.content.map(c => typeof c === "string" ? c : c.text || "").join("")
          : (typeof block.content === "string" ? block.content : "");
        const pathMatch = resultText.match(/\/?(?:[\w./-]+\/)*[\w.-]+\.(?:png|jpg|jpeg|gif|webp)/i);
        if (pathMatch) {
          const imgPath = resolve(session.workDir, pathMatch[0]);
          if (existsSync(imgPath)) {
            tgSendPhoto(CONTROL_CHAT_ID, imgPath, topicId, imgPath.split("/").pop())
              .catch(() => {});
          }
        }
      }
    };

    const result = await runClaude(session, promptText, { onThinking, onToolUse, onToolResult });

    // Flush any remaining thinking
    clearTimeout(thinkingFlushTimer);
    await flushThinking();

    console.error(`Claude returned for "${session.name}": ${result.response.slice(0, 100)}`);

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
    console.error(`Error in session "${session.name}":`, err.message);
    await tgSend(CONTROL_CHAT_ID, `❌ ${err.message}`, topicId);
  } finally {
    clearInterval(typingIv);
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
        console.error(`Update: ${JSON.stringify(update).slice(0, 500)}`);

        // --- Handle emoji reactions (auto-allow permissions) ---
        const reaction = update.message_reaction;
        if (reaction) {
          if (reaction.user?.id !== ALLOWED_USER_ID) continue;
          if (reaction.chat.id !== CONTROL_CHAT_ID) continue;
          const entry = pendingPermissions.get(reaction.message_id);
          if (!entry) continue;

          const emojis = (reaction.new_reaction || []).map(r => r.emoji);
          const hasEmoji = (e) => emojis.some(em => em.replace(/\uFE0F/g, "") === e.replace(/\uFE0F/g, ""));
          if (hasEmoji("👍")) {
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
          } else if (hasEmoji("❤️") || hasEmoji("❤")) {
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
          } else if (hasEmoji("🤖")) {
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
        if (!msg) continue;
        if (msg.from.id !== ALLOWED_USER_ID) continue;
        if (msg.chat.id !== CONTROL_CHAT_ID) continue;

        const topicId = msg.message_thread_id || null;

        // Determine message content (text or media)
        const hasMedia = msg.photo || msg.voice || msg.audio || msg.video || msg.video_note || msg.document;
        const rawText = msg.text || msg.caption || "";
        if (!rawText && !hasMedia) continue;

        // --- General topic: handle commands ---
        const isGeneral = !topicId || topicId === 1;
        if (isGeneral) {
          const cmdMatch = CMD_RE.exec(rawText.trim());
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

        // Build prompt: download media if present, otherwise use text
        let promptText;
        if (hasMedia) {
          try {
            const media = await extractMedia(msg, session.workDir);
            promptText = media ? media.text : rawText.trim();
          } catch (err) {
            console.error("Media download error:", err.message);
            await tgSend(CONTROL_CHAT_ID, `⚠️ Failed to download media: ${err.message}`, topicId);
            if (!rawText.trim()) continue;
            promptText = rawText.trim();
          }
        } else {
          promptText = rawText.trim();
        }

        if (!promptText) continue;

        // Fire and forget — don't block the poll loop
        handleSessionMessage(session, topicId, promptText);
      }
    } catch (err) {
      console.error("Poll error:", err.message);
    }
  }
}

// Backfill missing topics for existing sessions
async function backfillTopics() {
  let changed = false;
  for (const session of sessions) {
    if (!session.toolTopicId) {
      const res = await tgApi("createForumTopic", {
        chat_id: CONTROL_CHAT_ID,
        name: `🔧 ${session.name}`,
      });
      if (res.ok) {
        session.toolTopicId = res.result.message_thread_id;
        changed = true;
        console.error(`Created tool topic for "${session.name}"`);
      }
    }
    if (!session.thinkingTopicId) {
      const res = await tgApi("createForumTopic", {
        chat_id: CONTROL_CHAT_ID,
        name: `🧠 ${session.name}`,
      });
      if (res.ok) {
        session.thinkingTopicId = res.result.message_thread_id;
        changed = true;
        console.error(`Created thinking topic for "${session.name}"`);
      }
    }
  }
  if (changed) saveSessions();
}

backfillTopics().then(() => poll());
