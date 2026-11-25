# herdr-telegram-notify

Sends a Telegram message when an agent in Herdr finishes or needs input, and
lets you answer that agent from the chat. It runs as a plugin under Herdr TUI,
and as a small daemon next to herdr-core for the Herdr app.

This repository is a fork of
[naturalmoods/herdr-telegram-notify](https://github.com/naturalmoods/herdr-telegram-notify),
snapshotted at the commit recorded in `.upstream-sha`. [What this fork
adds](#what-this-fork-adds) lists the differences and nothing else differs, so a
bug in the rest belongs in upstream's issue tracker. MIT, upstream's copyright
kept.

## Features

- [Notifications](docs/guide.md#the-message): title, prompt, changes, timing, usage and the last response from Claude Code, Codex or pi.
- [Replies and buttons](docs/guide.md#replies-and-commands): answer the notified agent, with session and stale-question checks.
- [Files and photos](docs/guide.md#files-and-photos) and [voice](docs/guide.md#voice-messages): send attachments or locally transcribed speech.
- [Remote commands](docs/guide.md#commands): stop work, read a screen or diff, download a response, or start an agent in a tab or worktree.
- [A current chat](docs/guide.md#keeping-the-chat-current): resolved notifications and an optional pinned herd board.
- [Sidebar state](docs/guide.md#sidebar-tokens): notification, phone-input and mute badges at the desk.
- [Noise control](docs/guide.md#noise-control): quiet hours, short-turn filtering, blocked delays, workspace filters and muting.
- [Best-effort secret masking](docs/guide.md#secret-masking), [retries and reminders](docs/guide.md#failed-sends-and-the-sweeper), and [doctor](docs/guide.md#doctor).

## What this fork adds

Upstream has a single duration floor for every status, and every rule lives in
the `.env`, which you edit by hand. This fork keeps the rules in a policy you can
edit from the phone, and it stops treating a blocked agent like a turn that
merely ran short.

A blocked agent is the case worth interrupting you for. An exhausted provider
quota looks exactly like a turn that is still thinking, so a floor on that status
means finding out hours later. `DONE_MIN_DURATION_SECONDS`,
`BLOCKED_MIN_DURATION_SECONDS`, `WORKING_MIN_DURATION_SECONDS`,
`IDLE_MIN_DURATION_SECONDS` and `ERROR_MIN_DURATION_SECONDS` each take their own
number; all of them except `blocked` fall back to `MIN_DURATION_SECONDS`, and
`blocked` inherits no floor at all.

`BLOCKED_REPEAT_MINUTES` reports a pane again for as long as it stays blocked,
instead of only at the moment it got stuck. `BLOCKED_IGNORE_QUIET_HOURS=1` lets
those repeats through at night.

`/settings`, `/settings all`, `/only blocked`, `/min done 120`, `/set KEY VALUE`
and `/unset KEY` change the policy from the chat. The daemon re-reads the `.env`
on every event, so no restart is involved. The token and the chat id are not
writable from there, by design.

The sweeper runs when a reminder needs it, not only on `SWEEP_MINUTES`, and never
on a timer Node cannot sleep.

The rules live in `policy.mjs` with `test/policy.test.mjs`; `notify.mjs`,
`replies.mjs`, `lib.mjs` and `doctor.mjs` call into it. The four test files that
cover those modules grew with them, and `docs/guide.md`, `docs/core.md`,
`.env.example` and `CHANGELOG.md` document the additions. No other file differs
from the snapshot.

## Requirements

Herdr TUI 0.8+ or herdr-core (the Herdr app), Node 18+, Linux or macOS.
Linux needs util-linux's `flock`. macOS: `brew install util-linux` (or
`brew install flock`).

## Install

### Herdr TUI

```sh
herdr plugin install naturalmoods/herdr-telegram-notify --yes
```

For a local checkout, run `herdr plugin link .` instead. The launcher finds
Node outside the shell's PATH.

### The Herdr app (herdr-core)

The app runs agents in herdr-core (`hc`), which has no plugin hooks. Run
`daemon.mjs` on the machine where the agents run instead; it follows
`hc events` and sends the same messages, also while the app window is closed.

```sh
git clone https://github.com/naturalmoods/herdr-telegram-notify ~/.local/share/herdr-telegram-notify
```

Set it up as below, then run it as a systemd user service with
[`contrib/herdr-telegram-notify.service`](contrib/herdr-telegram-notify.service).
Service setup and what works differently: [docs/core.md](docs/core.md).

Use one runtime per bot with replies on: if a machine runs both, give the
daemon its own bot.

## Setup

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and keep the token private.
2. Open your new bot, press Start and send a message. Read the chat id with your token:

   ```sh
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
   ```

   For groups and forum topics, see [setup](docs/guide.md#configure).
3. Find the config directory. Under Herdr TUI:

   ```sh
   herdr plugin config-dir naturalmoods.herdr-telegram-notify
   ```

   For the app it is `~/.config/herdr-telegram-notify`. Create `.env` there with:

   ```dotenv
   TELEGRAM_BOT_TOKEN=<your bot token>
   TELEGRAM_CHAT_ID=<your chat id>
   ```

4. Restrict access and check the setup:

   ```sh
   # Herdr TUI
   chmod 600 "$(herdr plugin config-dir naturalmoods.herdr-telegram-notify)/.env"
   herdr plugin action invoke doctor --plugin naturalmoods.herdr-telegram-notify

   # the app
   chmod 600 ~/.config/herdr-telegram-notify/.env
   node ~/.local/share/herdr-telegram-notify/daemon.mjs doctor
   ```

Doctor sends a silent test message. Under Herdr TUI its report is in
`herdr plugin log list`; the app's doctor prints it.
All other settings are optional: see [`.env.example`](.env.example) and the
[complete guide](docs/guide.md). Telegram bot chats are not end-to-end encrypted;
secret masking is not a guarantee.

## Turn on replies

Set `REPLIES=1` in `.env`, then reply to a notification in Telegram. The poller
starts when Herdr or the daemon starts, or on the next agent status change, and registers the
commands menu automatically. A blocked agent gets typed input and Enter;
other agents get a new turn. [Reply rules and limits](docs/guide.md#replies-and-commands).

- Only the configured `TELEGRAM_CHAT_ID` is listened to.
- In groups, set `REPLY_ALLOWED_USER_IDS` to trusted Telegram user ids; otherwise every member can control agents, including starting them and creating worktrees.
- Use one bot per machine with replies enabled. Send-only machines may share a bot.

## Commands

All commands need `REPLIES=1` and use the chat and sender allowlist above.
`/full`, `/stop`, `/screen` and `/diff` must reply to a notification; notifications
also carry them as buttons.

| Command | Result |
| --- | --- |
| `/status` | List agents and their states. |
| `/mute [minutes]` | Mute for the configured duration (default 60), or the supplied minutes. |
| `/unmute` | Turn notifications back on. |
| `/full` | Download the saved response before message truncation. |
| `/stop` | Send Esc to a working or blocked agent, without quitting it. |
| `/screen` | Read up to 40 cropped lines of the agent's current screen. |
| `/diff` | Download staged and unstaged changes; list untracked names only. |
| `/new <workspace>[@<branch>] <kind> [prompt]` | Start an agent in a background tab, or its own Git worktree. |
| `/settings [all]` | What reaches the phone now, or every key and its value. |
| `/only blocked` | Notify for these statuses only. |
| `/min done 120` | Shortest turn of a status worth a message; `/min done off` removes it. |
| `/set KEY VALUE` · `/unset KEY` | Change any notification setting from the chat. |

You can change from the chat every setting that controls whether a message is
sent, and the daemon reads them from the `.env` in the config dir on each event,
so no restart is involved. That covers `/only blocked` for a blocked-only bot,
and a floor per status, so you can silence short `done` turns while a `blocked`
agent still reports at any duration. `BLOCKED_REPEAT_MINUTES` keeps reporting the
ones that stay blocked.

[Command details, safety checks and limits](docs/guide.md#commands).

## Sidebar

Herdr TUI: run `herdr plugin action invoke sidebar --plugin naturalmoods.herdr-telegram-notify`.
Then reload config from the Herdr menu (or your `reload_config` key).
Over SSH, run it where the Herdr window runs: the layout belongs to the config on
the client machine, not on the server. [Details](docs/guide.md#sidebar-tokens).

In the Herdr app, a mod draws the same badges in a band at the bottom of the
window instead: [install it](docs/core.md#sidebar).

## Upgrading

Reinstall with the install command above, or `git pull` in a linked checkout.
Stop the old poller and sweeper so they load the new code:

```sh
pkill -f replies.mjs
pkill -f 'notify.mjs --sweep'
```

They restart on the next status change or Herdr start when enabled.
[Upgrade details](docs/guide.md#upgrading).

For the app, `git pull` in the clone and restart the service:
`systemctl --user restart herdr-telegram-notify`.

## Full reference

[docs/guide.md](docs/guide.md) covers every setting, limitation and example,
including topics, attachment and voice setup, the sweeper, troubleshooting and testing.
The repo also includes a [setup skill](.claude/skills/herdr-telegram-notify/SKILL.md).

## Uninstall

```sh
# Herdr TUI
herdr plugin uninstall naturalmoods.herdr-telegram-notify

# the app
systemctl --user disable --now herdr-telegram-notify
rm ~/.config/systemd/user/herdr-telegram-notify.service
```
