// The rules that decide whether a status reaches the phone, and the editor the
// bot uses to change them from the chat. Both are pure enough to test directly:
// policy.mjs reads a config function, never the environment, and writes only the
// .env it is handed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DEFAULTS } from "../lib.mjs";
import {
  EDITABLE_KEYS,
  knownStatus,
  minDurationKey,
  policySilent,
  policySummary,
  reminderDue,
  reminderTiming,
  settingsList,
  statusMinDurationSeconds,
  sweepIntervalMs,
  validateSetting,
  writeEnvSetting,
} from "../policy.mjs";

// A config function over a plain object, defaults included — the same shape
// loadConfig() hands the notifier.
const conf = (overrides = {}) => {
  const values = { ...DEFAULTS, ...overrides };
  return (key) => values[key];
};

const MINUTE = 60 * 1000;

test("a global floor quiets short turns but never a blocked one", () => {
  const cfg = conf({ MIN_DURATION_SECONDS: "60" });
  assert.equal(statusMinDurationSeconds(cfg, "done"), 60);
  assert.equal(statusMinDurationSeconds(cfg, "idle"), 60);
  // The whole point: a quota that ran out looks like a long turn, so this is
  // the one status the global floor must not swallow.
  assert.equal(statusMinDurationSeconds(cfg, "blocked"), 0);
});

test("a status with its own floor uses it, and an empty one falls back", () => {
  const cfg = conf({ MIN_DURATION_SECONDS: "60", DONE_MIN_DURATION_SECONDS: "120" });
  assert.equal(statusMinDurationSeconds(cfg, "done"), 120);
  assert.equal(statusMinDurationSeconds(cfg, "error"), 60);
  // 0 is a value, not an absence: it says "no floor" rather than "inherit".
  assert.equal(statusMinDurationSeconds(conf({ MIN_DURATION_SECONDS: "60", DONE_MIN_DURATION_SECONDS: "0" }), "done"), 0);
});

test("blocked can be given a floor of its own, but only explicitly", () => {
  const cfg = conf({ MIN_DURATION_SECONDS: "60", BLOCKED_MIN_DURATION_SECONDS: "5" });
  assert.equal(statusMinDurationSeconds(cfg, "blocked"), 5);
  assert.equal(statusMinDurationSeconds(conf({ MIN_DURATION_SECONDS: "60" }), "blocked"), 0);
});

test("quiet hours silence a message unless blocked is exempted", () => {
  // A window that covers every hour of the day, whatever the clock says.
  const quiet = conf({ QUIET_HOURS: "00:00-23:59" });
  assert.equal(policySilent(quiet, "done"), true);
  assert.equal(policySilent(quiet, "blocked"), true);
  const exempt = conf({ QUIET_HOURS: "00:00-23:59", BLOCKED_IGNORE_QUIET_HOURS: "1" });
  assert.equal(policySilent(exempt, "blocked"), false);
  // Only blocked: a done turn at 03:00 still arrives silently.
  assert.equal(policySilent(exempt, "done"), true);
});

test("a blocked stretch is nudged once, then repeated on its own clock", () => {
  const cfg = conf({ BLOCKED_REMINDER_MINUTES: "10", BLOCKED_REPEAT_MINUTES: "30" });
  const now = 1000 * MINUTE;
  const state = { status: "blocked", paneId: "wA:p1", updatedAt: now - 5 * MINUTE };
  assert.equal(reminderDue(state, cfg, now), undefined, "nothing is owed before the first delay");
  assert.equal(reminderDue({ ...state, updatedAt: now - 11 * MINUTE }, cfg, now), "first");
  // Already nudged: the repeat's own clock starts at that nudge, not at the
  // start of the stretch, or a long wait would repeat on every pass.
  assert.equal(reminderDue({ ...state, remindedAt: now - 29 * MINUTE }, cfg, now), undefined);
  assert.equal(reminderDue({ ...state, remindedAt: now - 31 * MINUTE }, cfg, now), "repeat");
});

test("without a first delay the first repeat is measured from when the wait began", () => {
  // Repeats on their own have to work: BLOCKED_REPEAT_MINUTES is the setting that
  // reports a blocked pane that never changes status, and a stretch that was
  // never nudged has no `remindedAt` to measure from. Measuring from nothing is
  // how this feature can look configured and stay silent for ever.
  const cfg = conf({ BLOCKED_REMINDER_MINUTES: "0", BLOCKED_REPEAT_MINUTES: "10" });
  const now = 1000 * MINUTE;
  const state = { status: "blocked", paneId: "wA:p1", updatedAt: now - 60 * MINUTE };
  assert.equal(reminderDue(state, cfg, now), "repeat");
  assert.equal(reminderDue({ ...state, updatedAt: now - 5 * MINUTE }, cfg, now), undefined);
  // Once nudged, the clock is the nudge.
  assert.equal(reminderDue({ ...state, remindedAt: now - 11 * MINUTE }, cfg, now), "repeat");
  // With neither timing set nothing repeats at all, however long it stands.
  assert.equal(reminderDue(state, conf(), now), undefined);
});

test("a repeat needs a repeat setting, and only a blocked pane owes anything", () => {
  const cfg = conf({ BLOCKED_REMINDER_MINUTES: "5", BLOCKED_REPEAT_MINUTES: "0" });
  const now = 1000 * MINUTE;
  const nudged = { status: "blocked", paneId: "wA:p1", updatedAt: now - 60 * MINUTE, remindedAt: now - 60 * MINUTE };
  assert.equal(reminderDue(nudged, cfg, now), undefined);
  assert.equal(reminderDue({ ...nudged, status: "done" }, cfg, now), undefined);
  // No pane id means no pane to confirm live, so nothing to say about it.
  assert.equal(reminderDue({ status: "blocked", updatedAt: now - 60 * MINUTE }, cfg, now), undefined);
});

test("the sweeper wakes for the shortest of its three reasons, and not at all by default", () => {
  assert.equal(sweepIntervalMs(conf()), 0);
  assert.equal(sweepIntervalMs(conf({ SWEEP_MINUTES: "5" })), 5 * MINUTE);
  // A reminder cannot wait for an event that will not come — a blocked pane
  // stops changing status, which is the whole situation being reported — so
  // either one starts the sweeper on its own.
  assert.equal(sweepIntervalMs(conf({ BLOCKED_REPEAT_MINUTES: "10" })), 10 * MINUTE);
  assert.equal(sweepIntervalMs(conf({ BLOCKED_REMINDER_MINUTES: "5" })), 5 * MINUTE);
  assert.equal(sweepIntervalMs(conf({ SWEEP_MINUTES: "10", BLOCKED_REPEAT_MINUTES: "2" })), 2 * MINUTE);
  assert.equal(sweepIntervalMs(conf({ SWEEP_MINUTES: "10", BLOCKED_REMINDER_MINUTES: "3" })), 3 * MINUTE);
  // Never less than the floor, whatever is asked for.
  assert.equal(sweepIntervalMs(conf({ SWEEP_MINUTES: "1", BLOCKED_REPEAT_MINUTES: "0" })), MINUTE);
  assert.equal(reminderTiming(conf({ BLOCKED_REPEAT_MINUTES: "1" })).repeatMs, MINUTE);
  // Past the point Node clamps a timer to 1ms, the value is capped rather than
  // handed to setTimeout.
  const huge = conf({ BLOCKED_REMINDER_MINUTES: "99999999999999999999" });
  assert.ok(sweepIntervalMs(huge) <= 2_147_483_647);
});

test("the chat may change notification settings and not the credentials", () => {
  assert.ok(EDITABLE_KEYS.includes("QUIET_HOURS"));
  assert.ok(EDITABLE_KEYS.includes("BLOCKED_REPEAT_MINUTES"));
  assert.ok(!EDITABLE_KEYS.includes("TELEGRAM_BOT_TOKEN"));
  assert.ok(!EDITABLE_KEYS.includes("TELEGRAM_CHAT_ID"));
  // What a bare /mute uses is a notification setting too, and one a phone user
  // reaches for: it lives in EXTRA_KEYS, so it is named here on purpose.
  assert.ok(EDITABLE_KEYS.includes("MUTE_MINUTES"));
  assert.equal(validateSetting("MUTE_MINUTES", "30"), undefined);
  assert.match(validateSetting("MUTE_MINUTES", "0"), /1 or more/);
});

test("a timer longer than Node can sleep is refused rather than handed to setTimeout", () => {
  // Node clamps a delay above 2^31-1 ms to 1ms, which turns a sleepy sweeper
  // into a spinning one — so the value has to be refused at write time and the
  // interval capped at read time, in case an existing .env already holds one.
  assert.match(validateSetting("SWEEP_MINUTES", "40000"), /capped at 10080/);
  assert.equal(validateSetting("SWEEP_MINUTES", "10080"), undefined);
  const absurd = conf({ BLOCKED_REPEAT_MINUTES: "99999999999999999999" });
  assert.ok(Number.isFinite(sweepIntervalMs(absurd)));
  assert.ok(sweepIntervalMs(absurd) <= 2_147_483_647);
});

test("a rewrite cannot leave a reader with half a file", () => {
  // The .env holds the token every hook process reads. It is written beside
  // itself and renamed over the original, so a reader sees the old file or the
  // new one and never a truncated one: the temporary never survives a write,
  // and a missing original is not an error.
  const dir = mkdtempSync(join(tmpdir(), "policy-atomic-"));
  const before = readdirSync(dir);
  writeEnvSetting(dir, "DONE_MIN_DURATION_SECONDS", "30");
  const text = readFileSync(join(dir, ".env"), "utf8");
  assert.match(text, /^DONE_MIN_DURATION_SECONDS=30$/m);
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
  const stray = readdirSync(dir).filter((name) => !before.includes(name) && !["..", ".", ".env"].includes(name));
  assert.deepEqual(stray.filter((name) => name.startsWith(".env.") && name.endsWith(".tmp")), [], `temporary files left behind: ${stray}`);
});

test("a value is checked before it is written, and the reason says what is wrong", () => {
  assert.equal(validateSetting("QUIET_HOURS", "23:00-07:00"), undefined);
  assert.match(validateSetting("QUIET_HOURS", "23:00"), /HH:MM-HH:MM/);
  assert.match(validateSetting("NOTIFY_STATUSES", "blokced"), /not a status/);
  assert.match(validateSetting("NOTIFY_STATUSES", ""), /at least one status/);
  assert.match(validateSetting("DONE_MIN_DURATION_SECONDS", "-1"), /whole number/);
  assert.equal(validateSetting("DONE_MIN_DURATION_SECONDS", "0"), undefined);
  assert.match(validateSetting("SWEEP_MINUTES", "often"), /whole number/);
  assert.match(validateSetting("NOT_A_KEY", "1"), /not a notification setting/);
  assert.match(validateSetting("TELEGRAM_BOT_TOKEN", "123:abc"), /not a notification setting/);
  // Unset means back to the default, which is only allowed where a default is.
  assert.equal(validateSetting("QUIET_HOURS", undefined), undefined);
  // NOTIFY_STATUSES has a default too, so it can be put back from the chat: an
  // empty value is still refused, because that would name no status at all.
  assert.equal(validateSetting("NOTIFY_STATUSES", undefined), undefined);
});

test("a state with no known start is not nudged about with a broken wait", () => {
  // A state file from an older scheme carries no updatedAt. Reporting it would
  // put `NaNh` where the wait belongs, which is worse than staying quiet about
  // a stretch whose length nobody recorded.
  const cfg = (key) => ({ BLOCKED_REPEAT_MINUTES: "10" })[key];
  assert.equal(reminderDue({ status: "blocked", paneId: "p1" }, cfg, Date.now()), undefined);
  assert.equal(
    reminderDue({ status: "blocked", paneId: "p1", updatedAt: Date.now() - 3600_000 }, cfg, Date.now()),
    "repeat"
  );
});

test("a write keeps the rest of the file, including comments and the token", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-"));
  const path = join(dir, ".env");
  writeFileSync(
    path,
    ["# the bot", "TELEGRAM_BOT_TOKEN=123:abc", "QUIET_HOURS=22:00-06:00", "", "# a note about done", "DONE_MIN_DURATION_SECONDS=30", ""].join("\n"),
    { mode: 0o600 }
  );
  writeEnvSetting(dir, "QUIET_HOURS", "23:00-07:00");
  const text = readFileSync(path, "utf8");
  assert.match(text, /^# the bot$/m);
  assert.match(text, /^TELEGRAM_BOT_TOKEN=123:abc$/m);
  assert.match(text, /^QUIET_HOURS=23:00-07:00$/m);
  assert.match(text, /^# a note about done$/m);
  assert.equal(statSync(path).mode & 0o777, 0o600, "the file keeps its private mode");

  // A key that is not there yet is appended, and one set twice is left once.
  writeEnvSetting(dir, "BLOCKED_REPEAT_MINUTES", "10");
  writeEnvSetting(dir, "QUIET_HOURS", "01:00-02:00");
  const after = readFileSync(path, "utf8");
  assert.equal(after.match(/^QUIET_HOURS=/gm).length, 1);
  assert.match(after, /^BLOCKED_REPEAT_MINUTES=10$/m);
  // A value with a space or a hash would otherwise be read back cut short.
  writeEnvSetting(dir, "TELEGRAM_TOPICS", "storefront:12 # main");
  assert.match(readFileSync(path, "utf8"), /^TELEGRAM_TOPICS="storefront:12 # main"$/m);

  // Unset removes the line rather than writing an empty one, so the default
  // applies again and the file says so by saying nothing.
  writeEnvSetting(dir, "DONE_MIN_DURATION_SECONDS", undefined);
  assert.ok(!readFileSync(path, "utf8").includes("DONE_MIN_DURATION_SECONDS"));
});

test("the summary names what is in force, and the key list hides the secrets", () => {
  const cfg = conf({ MIN_DURATION_SECONDS: "60", BLOCKED_REPEAT_MINUTES: "10", TELEGRAM_BOT_TOKEN: "123:abc" });
  const summary = policySummary(cfg, { envPath: "/tmp/x/.env" });
  // The statuses are listed one by one, with the ones that notify marked.
  assert.match(summary, /✅ done · ✅ blocked/);
  assert.match(summary, /▫️ working/);
  assert.match(summary, /10/);
  assert.match(summary, /\/tmp\/x\/\.env/);

  const all = settingsList(cfg, { envPath: "/tmp/x/.env" });
  assert.match(all, /QUIET_HOURS/);
  assert.ok(!all.includes("123:abc"), "the token is not echoed into the chat");
});

test("status helpers agree with the status list", () => {
  assert.equal(knownStatus("done"), true);
  assert.equal(knownStatus("DONE"), true);
  assert.equal(knownStatus("nope"), false);
  assert.equal(minDurationKey("blocked"), "BLOCKED_MIN_DURATION_SECONDS");
  assert.equal(minDurationKey("nope"), undefined);
});
