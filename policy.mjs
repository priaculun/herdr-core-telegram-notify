// What decides whether a status reaches the phone, kept apart from the code
// that sends it. Two things live here: the per-status rules the notifier reads
// on every event, and the editor the bot uses to change them from Telegram.
//
// The rules are deliberately one-directional: a blocked agent is the one case
// where silence costs money (a provider quota that ran out looks exactly like a
// turn that is thinking), so `blocked` never inherits a duration meant to quiet
// short `done` turns. It can be given one of its own, and nothing else.

import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  DEFAULTS,
  MUTE_MAX_MINUTES,
  STATUSES,
  flockAvailable,
  holdFlock,
  inQuietHours,
  isOn,
  notifyStatuses,
  parseQuietHours,
  toInt,
} from "./lib.mjs";

// The order a summary lists them in: the two that notify by default first, which
// is also the order lib.mjs already keeps them in. One list, so a status added
// to the notifier cannot be missing from what the phone is told about it.
export const STATUSES_FOR_SUMMARY = STATUSES;

// `MIN_DURATION_SECONDS` is the global floor from 0.6 and still means what it
// did. Each status may override it, which is what makes "quiet for done, loud
// for blocked" a setting rather than a fork.
export const STATUS_MIN_DURATION_KEYS = Object.fromEntries(
  STATUSES.map((status) => [status, `${status.toUpperCase()}_MIN_DURATION_SECONDS`])
);

// Statuses whose own key falls back to MIN_DURATION_SECONDS. `blocked` is not
// among them: it inherits nothing, so a global floor set to quiet short turns
// cannot also swallow the question that is waiting for an answer. Anything else
// herdr reports — `closed`, which this plugin synthesises for a pane going away
// — keeps inheriting it, the way it did before the floors were per status.
function inheritsGlobalMinDuration(status) {
  return status !== "blocked";
}

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
  if (!inheritsGlobalMinDuration(status)) return 0;
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
    firstMs: minutesMs(cfg("BLOCKED_REMINDER_MINUTES")),
    repeatMs: minutesMs(cfg("BLOCKED_REPEAT_MINUTES")),
  };
}

// Whether this pane's blocked stretch owes a message now, and which one it is.
// Both timings read the state the notifier already writes: `updatedAt` is when
// the stretch began, `remindedAt` when it was last nudged about.
export function reminderDue(state, cfg, now = Date.now()) {
  const { firstMs, repeatMs } = reminderTiming(cfg);
  if (state?.status !== "blocked" || !state.paneId) return undefined;
  if (!state.remindedAt) {
    // The stretch has not been nudged about yet, so the next message is either
    // the first nudge or — with no first-nudge delay configured — the first
    // repeat. A repeat measured from nothing would never fire, which is why it
    // is measured from when the stretch began.
    //
    // No updatedAt means no known start: a state file left by an older scheme,
    // or one written before the clock was recorded. The wait it would report is
    // NaN, so it is treated as not due rather than nudged about with a broken
    // duration.
    if (!Number.isFinite(state.updatedAt)) return undefined;
    const from = firstMs || repeatMs;
    if (!from || now - state.updatedAt < from) return undefined;
    return firstMs ? "first" : "repeat";
  }
  if (!repeatMs || now - state.remindedAt < repeatMs) return undefined;
  return "repeat";
}

// How often the sweeper has to wake. A reminder shorter than SWEEP_MINUTES
// would arrive late by however much the sweeper oversleeps, so the shortest of
// the three wins. 0 means nothing needs sweeping: no queue timer, and no
// reminder to keep time for.
//
// A blocked stretch that stops changing status is exactly the case no further
// event arrives for, so both reminders need a clock of their own. Sweeping is
// serialised by SWEEP_RUN_LOCK, so a timer that fires while a hook is sending
// finds the lock taken and leaves it to that send rather than sending twice.
const SWEEP_FLOOR_MS = 30 * 1000;
// Node clamps a delay above this to 1ms, which turns a sleepy sweeper into a
// spinning one: the value has to be refused rather than passed to setTimeout.
const MAX_TIMER_MS = 2_147_483_647;

// A whole number of minutes from the config, in ms, bounded so it can be slept
// on. Anything past the timer limit is capped there rather than overflowing —
// "every 40 years" and "every 68 years" are the same setting to anyone reading
// it on a phone.
function minutesMs(value) {
  const minutes = toInt(value, 0);
  if (!minutes) return 0;
  return Math.min(minutes * 60 * 1000, MAX_TIMER_MS);
}

export function sweepIntervalMs(cfg) {
  const { firstMs, repeatMs } = reminderTiming(cfg);
  const intervals = [minutesMs(cfg("SWEEP_MINUTES")), firstMs, repeatMs].filter((ms) => ms > 0);
  if (!intervals.length) return 0;
  return Math.max(SWEEP_FLOOR_MS, Math.min(...intervals));
}

// ----------------------------------------------------------------- settings

// The keys the bot may write. Not every key in DEFAULTS belongs here: a setting
// that decides what reaches the phone does, and one that decides what the bot is
// allowed to execute does not. The token and chat id are out because a chat that
// can rewrite the credential it is authenticated by is one bad message away from
// being locked out. The four below are the same class of mistake in different
// clothes: /set MASK_SECRETS 0 would print credentials into the chat, and
// WHISPER_BIN, CORE_AGENT_KINDS and CORE_MACHINES each name a program or a
// machine this process goes on to run. REPLY_ALLOWED_USER_IDS is the guest list
// for the chat itself, so widening it from inside the chat defeats it.
// MUTE_MINUTES is not in DEFAULTS (it lives in EXTRA_KEYS) but it is a
// notification setting like any other: it is what a bare /mute uses, so leaving
// it out would make the one setting a phone user reaches for most the one they
// have to go back to a shell for.
const NOT_EDITABLE = new Set([
  "MASK_SECRETS",
  "WHISPER_BIN",
  "WHISPER_MODEL",
  "WHISPER_LANGUAGE",
  "CORE_AGENT_KINDS",
  "CORE_MACHINES",
  "REPLY_ALLOWED_USER_IDS",
]);

export const EDITABLE_KEYS = [
  ...Object.keys(DEFAULTS).filter((key) => !NOT_EDITABLE.has(key)),
  "MUTE_MINUTES",
];

// A week. Past this the setting is not a schedule but a typo, and the timer it
// would configure is one Node clamps into a spin.
const MAX_TIMER_MINUTES = 10080;

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
  ["MUTE_MINUTES", { min: 1, max: MUTE_MAX_MINUTES }],
  ["TELEGRAM_TOPIC_ID", { min: 1 }],
  ["MIN_DURATION_SECONDS", { min: 0 }],
  ...STATUSES.map((status) => [STATUS_MIN_DURATION_KEYS[status], { min: 0 }]),
  ["BLOCKED_DELAY_SECONDS", { min: 0, max: 120 }],
  ["BLOCKED_REMINDER_MINUTES", { min: 0, max: MAX_TIMER_MINUTES }],
  ["BLOCKED_REPEAT_MINUTES", { min: 0, max: MAX_TIMER_MINUTES }],
  ["SWEEP_MINUTES", { min: 0, max: MAX_TIMER_MINUTES }],
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
    // undefined is /unset: the default comes back, which names statuses of its
    // own. Refusing it would make the one key that decides everything the only
    // one that cannot be put back from the chat.
    if (value === undefined) return undefined;
    const tokens = text.split(",").map((s) => s.trim()).filter(Boolean);
    // "," is non-empty and names nothing, which would leave the notifier
    // switched off entirely — including for blocked, the one status the whole
    // setup exists for. An empty list is the same mistake as a misspelled one.
    if (!tokens.length) return "NOTIFY_STATUSES needs at least one status";
    const bad = tokens.map((s) => s.toLowerCase()).filter((s) => !STATUSES.includes(s));
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
  // This file holds the credentials every hook process reads, and a hook can
  // start at any moment. Two writers must not interleave, and a reader must not
  // see a half-written file: the rewrite is serialised by a lock and lands with
  // one rename, so a concurrent loadConfig() reads either the old file or the
  // new one. Without flock there is no lock — the write is still atomic, which
  // is the part that matters for a reader.
  const release = holdFlock(`${path}.lock`, { waitSeconds: 5 });
  // holdFlock answers undefined both when flock(1) is missing and when the wait
  // ran out. The first is a machine without the tool and the write is still
  // atomic, so it goes ahead; the second means another /set is mid-rewrite, and
  // two whole-file rewrites without the lock lose one of them — the loser would
  // then read the winner's value back and report it as its own.
  if (release === undefined && flockAvailable()) {
    throw new Error(`could not lock ${path} to change ${key}; try again in a moment`);
  }
  try {
    return writeEnvLocked(path, key, value);
  } finally {
    release?.();
  }
}

function writeEnvLocked(linkPath, key, value) {
  // A dotfiles setup symlinks .env into a repo. Renaming over the link would
  // replace it with a regular file: the repo keeps the old value and the next
  // sync quietly reverts the setting. So the real file is what gets rewritten.
  let path = linkPath;
  try {
    path = realpathSync(linkPath);
  } catch {
    // No file yet, or a link whose target is gone: write where it was asked for.
  }
  const dir = dirname(path);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // Anything but a missing file means the rewrite would silently drop
    // settings that are there but unreadable.
    if (err.code !== "ENOENT") throw err;
  }
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
  // Written beside the file and renamed over it: rename(2) is atomic within a
  // directory, so no reader ever sees a truncated .env, and a crash mid-write
  // leaves the old file rather than half of a new one.
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {}
    throw err;
  }
  return path;
}

// ------------------------------------------------------------------- report

const yes = (on) => (on ? "yes" : "no");
const duration = (seconds) => (seconds ? `${seconds}s` : "off");

// What the notifier will do with each status right now, as one message. Values
// come from the resolved config, so an env var set outside .env is shown as it
// is really applied.
export function policySummary(cfg, { muteUntil, envPath } = {}) {
  // notifyStatuses(), not the raw key: on herdr-core it adds `error` to the
  // default, and a summary that read the key alone would show that status as
  // off while the notifier was sending it.
  const statuses = new Set(notifyStatuses(cfg));
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
  const minutes = (ms) => (ms ? `${Math.round(ms / 60000)}m` : "off");
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
    // Same reason as policySummary: on herdr-core the default grows `error`, and
    // a list that showed the raw key would contradict what is being sent.
    const value = key === "NOTIFY_STATUSES" ? notifyStatuses(cfg).join(",") : cfg(key);
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
