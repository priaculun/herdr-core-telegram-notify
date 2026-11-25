// What decides whether a status reaches the phone, kept apart from the code
// that sends it. Two things live here: the per-status rules the notifier reads
// on every event, and the editor the bot uses to change them from Telegram.
//
// The rules are deliberately one-directional: a blocked agent is the one case
// where silence costs money (a provider quota that ran out looks exactly like a
// turn that is thinking), so `blocked` never inherits a duration meant to quiet
// short `done` turns. It can be given one of its own, and nothing else.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

import { DEFAULTS, STATUSES, inQuietHours, isOn, parseQuietHours, toInt } from "./lib.mjs";

// The order a summary lists them in, which is the order they matter in to
// someone reading it on a phone: the two that notify by default first.
export const STATUSES_FOR_SUMMARY = ["done", "blocked", "working", "idle", "error"];

// `MIN_DURATION_SECONDS` is the global floor from 0.6 and still means what it
// did. Each status may override it, which is what makes "quiet for done, loud
// for blocked" a setting rather than a fork.
export const STATUS_MIN_DURATION_KEYS = Object.fromEntries(
  STATUSES.map((status) => [status, `${status.toUpperCase()}_MIN_DURATION_SECONDS`])
);

// Statuses whose own key falls back to MIN_DURATION_SECONDS. `blocked` is not
// among them: it inherits nothing, so a global floor set to quiet short turns
// cannot also swallow the question that is waiting for an answer.
const INHERITS_GLOBAL_MIN_DURATION = STATUSES.filter((status) => status !== "blocked");

// A whole number as written, or undefined. toInt() cannot be used here: it
// reports 0 as undefined, and for a floor 0 is the value that says "no floor",
// not the absence of one.
function wholeNumber(value) {
  const raw = String(value ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

// Seconds a turn of this status must have lasted before it is worth a message.
// 0 means no floor at all.
export function statusMinDurationSeconds(cfg, status) {
  const key = STATUS_MIN_DURATION_KEYS[status];
  const own = key ? wholeNumber(cfg(key)) : undefined;
  if (own !== undefined) return own;
  if (!INHERITS_GLOBAL_MIN_DURATION.includes(status)) return 0;
  return toInt(cfg("MIN_DURATION_SECONDS"), 0);
}

// Quiet hours make a message arrive without a sound; they never hold it back.
// A blocked agent can be exempted from even that, because the reason to look at
// the phone at 03:00 is precisely the one that cannot wait until morning.
export function policySilent(cfg, status) {
  if (status === "blocked" && isOn(cfg("BLOCKED_IGNORE_QUIET_HOURS"))) return false;
  return inQuietHours(cfg("QUIET_HOURS"));
}

// When a blocked pane that is still blocked gets another message. `first` is
// the nudge after the transition message went unanswered; `repeat` keeps them
// coming for as long as the pane stands there, which is what turns "it told me
// once, an hour ago" into "it is still stuck".
export function reminderTiming(cfg) {
  return {
    firstMs: toInt(cfg("BLOCKED_REMINDER_MINUTES"), 0) * 60 * 1000,
    repeatMs: toInt(cfg("BLOCKED_REPEAT_MINUTES"), 0) * 60 * 1000,
  };
}

// Whether this pane's blocked stretch owes a message now, and which one it is.
// Both timings read the state the notifier already writes: `updatedAt` is when
// the stretch began, `remindedAt` when it was last nudged about.
export function reminderDue(state, cfg, now = Date.now()) {
  const { firstMs, repeatMs } = reminderTiming(cfg);
  if (state?.status !== "blocked" || !state.paneId) return undefined;
  if (!state.remindedAt) {
    // Without a first-nudge delay the transition message is the notification;
    // repeating it a minute later would only teach you to ignore both.
    if (!firstMs || now - state.updatedAt < firstMs) return undefined;
    return "first";
  }
  if (!repeatMs || now - state.remindedAt < repeatMs) return undefined;
  return "repeat";
}

// How often the sweeper has to wake. A repeat shorter than SWEEP_MINUTES would
// arrive late by however much the sweeper oversleeps, so the shorter of the two
// wins. 0 means nothing needs sweeping: no queue timer, and no repeat to keep
// time for.
//
// BLOCKED_REMINDER_MINUTES is deliberately not consulted. The first nudge is
// owed by a pane that stopped changing status, and every event already sweeps —
// starting a timer for it would put a second sweep in flight at the moment a
// hook is trying to send, which is a lock to lose a message to, not a nudge to
// gain. A repeat has no event to ride on, so it does need the timer.
const SWEEP_FLOOR_MS = 30 * 1000;
export function sweepIntervalMs(cfg) {
  const intervals = [toInt(cfg("SWEEP_MINUTES"), 0) * 60 * 1000, reminderTiming(cfg).repeatMs].filter((ms) => ms > 0);
  if (!intervals.length) return 0;
  return Math.max(SWEEP_FLOOR_MS, Math.min(...intervals));
}

// ----------------------------------------------------------------- settings

// The keys the bot may write. Everything in DEFAULTS is a notification setting,
// which is what "custom from the phone" has to mean; the token and chat id are
// deliberately not among them — a chat that can rewrite the credential it is
// authenticated by is one bad message away from being locked out.
export const EDITABLE_KEYS = Object.keys(DEFAULTS);

const BOOLEAN_KEYS = new Set([
  "SHOW_TITLE", "SHOW_PROMPT", "SHOW_PROJECT", "SHOW_BRANCH", "SHOW_CHANGES", "SHOW_DURATION",
  "SHOW_TIMESTAMP", "SHOW_TOKENS", "SHOW_TOOLS", "SHOW_PANE", "SHOW_HOST", "SHOW_HERD",
  "SHOW_LAST_MESSAGE", "SHOW_SCREEN_ON_BLOCKED", "MASK_SECRETS", "REPLIES", "MARK_RESOLVED",
  "SIDEBAR_TOKENS", "BOARD", "DEBUG", "DRY_RUN", "BLOCKED_IGNORE_QUIET_HOURS",
]);

// Whole seconds or minutes, with the same bounds configProblems reports. 0 is
// allowed only where it means "off"; the sizes refuse it, since a zero-line
// screen is a message with a hole in it.
const NUMBER_KEYS = new Map([
  ["PROMPT_CHARS", { min: 1 }],
  ["LAST_MESSAGE_CHARS", { min: 1 }],
  ["SCREEN_LINES", { min: 1 }],
  ["MUTE_MINUTES", { min: 1 }],
  ["TELEGRAM_TOPIC_ID", { min: 1 }],
  ["MIN_DURATION_SECONDS", { min: 0 }],
  ...STATUSES.map((status) => [STATUS_MIN_DURATION_KEYS[status], { min: 0 }]),
  ["BLOCKED_DELAY_SECONDS", { min: 0, max: 120 }],
  ["BLOCKED_REMINDER_MINUTES", { min: 0 }],
  ["BLOCKED_REPEAT_MINUTES", { min: 0 }],
  ["SWEEP_MINUTES", { min: 0 }],
]);

// Why this value would not be read, or undefined when it would. The bot answers
// with the reason instead of writing a line that silently does nothing — the
// failure mode of a typo in .env is a setting that looks set.
export function validateSetting(key, value) {
  if (!EDITABLE_KEYS.includes(key)) {
    return `${key} is not a notification setting this bot can change`;
  }
  const text = String(value ?? "").trim();
  if (/[\r\n]/.test(text)) return `${key} must be one line`;

  if (BOOLEAN_KEYS.has(key)) {
    const ok = ["", "0", "1", "true", "false", "yes", "no", "on", "off"];
    return ok.includes(text.toLowerCase()) ? undefined : `${key} takes 1 or 0, not ${text}`;
  }
  const number = NUMBER_KEYS.get(key);
  if (number) {
    if (text === "") return undefined; // empty is the default
    if (!/^\d+$/.test(text)) return `${key} takes a whole number, not ${text}`;
    const n = Number(text);
    if (n < number.min) return `${key} takes ${number.min} or more`;
    if (number.max !== undefined && n > number.max) return `${key} is capped at ${number.max}`;
    return undefined;
  }
  if (key === "NOTIFY_STATUSES") {
    if (!text) return "NOTIFY_STATUSES needs at least one status";
    const bad = text.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s && !STATUSES.includes(s));
    return bad.length ? `${bad.join(", ")} is not a status (${STATUSES.join(", ")})` : undefined;
  }
  if (key === "QUIET_HOURS") {
    if (!text) return undefined;
    return parseQuietHours(text) ? undefined : `${text} is not HH:MM-HH:MM`;
  }
  if (key === "TELEGRAM_TOPICS") {
    for (const pair of text.split(",").map((s) => s.trim()).filter(Boolean)) {
      const at = pair.lastIndexOf(":");
      if (at < 1 || !toInt(pair.slice(at + 1), undefined)) return `${pair} is not workspace:topic`;
    }
    return undefined;
  }
  return undefined;
}

// A value as .env spells it: quoted when it would otherwise be read as a
// comment or split on spaces. Quotes inside are dropped rather than escaped,
// because loadEnvFile() strips the outer pair and unescapes nothing.
function envValue(value) {
  const text = String(value).replace(/"/g, "").replace(/[\r\n]/g, " ").trim();
  return /[\s#]/.test(text) ? `"${text}"` : text;
}

// Write one key into the config dir's .env, or drop it when value is undefined
// (the default comes back). Comments and every other line survive: this file
// holds the token and the notes explaining the settings, and rewriting it from
// a phone must not cost either.
export function writeEnvSetting(dir, key, value) {
  if (!dir) throw new Error("no config directory");
  const path = join(dir, ".env");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {}
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const rendered = value === undefined || String(value).trim() === "" ? undefined : `${key}=${envValue(value)}`;

  const out = [];
  let written = false;
  for (const line of text.split("\n")) {
    if (!assignment.test(line)) {
      out.push(line);
      continue;
    }
    // A second assignment of the same key would shadow this one depending on
    // who reads it, so all of them become the one line.
    if (rendered !== undefined && !written) {
      out.push(rendered);
      written = true;
    }
  }
  if (rendered !== undefined && !written) {
    while (out.length && out[out.length - 1] === "") out.pop();
    out.push(rendered, "");
  }
  const body = out.join("\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
  try {
    // writeFileSync only applies the mode to a new file.
    if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
  } catch {}
  return path;
}

// ------------------------------------------------------------------- report

const yes = (on) => (on ? "yes" : "no");
const duration = (seconds) => (seconds ? `${seconds}s` : "off");

// What the notifier will do with each status right now, as one message. Values
// come from the resolved config, so an env var set outside .env is shown as it
// is really applied.
export function policySummary(cfg, { muteUntil, envPath } = {}) {
  const statuses = new Set(
    String(cfg("NOTIFY_STATUSES") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const lines = [];
  lines.push("🔔 Notifications");
  lines.push(
    STATUSES.map((status) => `${statuses.has(status) ? "✅" : "▫️"} ${status}`).join(" · ")
  );
  lines.push("");
  lines.push("⏱ Min duration before a message");
  lines.push(
    STATUSES.map((status) => `${status} ${duration(statusMinDurationSeconds(cfg, status))}`).join(" · ")
  );
  lines.push("");
  const { firstMs, repeatMs } = reminderTiming(cfg);
  const minutes = (ms) => (ms ? `${ms / 60000}m` : "off");
  lines.push("🚧 Blocked");
  lines.push(`delay ${duration(toInt(cfg("BLOCKED_DELAY_SECONDS"), 0))} · nudge after ${minutes(firstMs)} · repeat every ${minutes(repeatMs)}`);
  lines.push(`ignores quiet hours: ${yes(isOn(cfg("BLOCKED_IGNORE_QUIET_HOURS")))}`);
  lines.push("");
  const quiet = String(cfg("QUIET_HOURS") ?? "").trim();
  lines.push(`🌙 Quiet hours: ${quiet ? `${quiet} (silent, not held back)` : "off"}`);
  const allowed = String(cfg("NOTIFY_WORKSPACES") ?? "").trim();
  const ignored = String(cfg("IGNORE_WORKSPACES") ?? "").trim();
  lines.push(`📁 Only: ${allowed || "every workspace"} · Ignore: ${ignored || "none"}`);
  if (muteUntil) lines.push(`🔕 Muted until ${new Date(muteUntil).toTimeString().slice(0, 5)}`);
  if (envPath) lines.push("", `Config: ${envPath}`);
  lines.push("", "Change: /set KEY VALUE · /unset KEY · /settings all · /only blocked · /min done 120");
  return lines.join("\n");
}

// Every setting the bot can write, with what is in force. Long by design: this
// is the one answer that makes the rest of the keys discoverable from a phone.
export function settingsList(cfg, { envPath } = {}) {
  const lines = ["⚙️ Settings (current values)"];
  for (const key of EDITABLE_KEYS) {
    const value = cfg(key);
    lines.push(`${key}=${value === undefined || value === "" ? "(default)" : value}`);
  }
  if (envPath) lines.push("", `Config: ${envPath}`);
  return lines.join("\n");
}

// The value a `/min <status> <seconds>` asks for, so the alias and /set cannot
// disagree about what a status's own key is called.
export function minDurationKey(status) {
  return STATUS_MIN_DURATION_KEYS[String(status ?? "").toLowerCase()];
}

export function knownStatus(status) {
  return STATUSES.includes(String(status ?? "").toLowerCase());
}
