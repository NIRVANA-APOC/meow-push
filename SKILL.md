---
name: meow-push
description: Send text or HTML push messages to a specified MeoW nickname via the meow CLI (api.chuckfang.com). Use when the user asks to push or send a notification/message to a MeoW user, or to check why a push failed. Confirm the recipient and content before sending; never retry automatically.
---

# MeoW Push (meow CLI)

Send messages to a MeoW nickname with the `meow` command. The API is an anonymous HTTP endpoint where the nickname identifies the recipient. **Only send when the user explicitly asks.** Building or previewing a request is read-only.

The offline API reference is in [references/api.md](references/api.md); no need to fetch the web page.

## Before sending

- **Recipient nickname** — if the user did not provide one, ask for it. Never guess a nickname from context.
- **Message content** — if missing, ask. Do not rewrite, translate, or polish the user's content.
- Use defaults instead of interrogating: title `MeoW`, type `text`.
- Send one message per call. Pushes are not idempotent.

## Preflight

```bash
command -v meow || echo "MISSING"
```

If `meow` is missing, install one of the two implementations from a repository checkout:

```bash
# TypeScript: cross-platform out of the box, needs Node.js >= 18.17, no build step
node ts-cli/dist/index.js --help    # run directly
npm install -g ./ts-cli             # or install it as `meow`

# Rust: single binary, optional fully static musl build
cargo install --path rust-cli --locked
```

The examples below assume `meow` is on `PATH` (replace it with `node ts-cli/dist/index.js` when running the TypeScript CLI from a checkout).

Optional: set a default nickname so it can be omitted from `push`:

```bash
meow config set nickname <nickname>   # writes ~/.config/meow/config.toml
meow config                           # show the current configuration
```

## Command cheat sheet

```bash
# Recommended: nickname + message (POST JSON by default, most robust)
meow push <nickname> "<message>"

# Title / link / custom icon
meow push <nickname> "<message>" --title "Build" \
  --url "https://example.com/detail" \
  --img-url "https://example.com/icon_216x216.png"

# HTML message (msgType=html; display height defaults to 200)
meow push <nickname> "<b>Build passed</b>" --html --html-height 300

# Long or multi-line message via stdin (trailing newlines are stripped)
printf '%s' "$LONG_TEXT" | meow push <nickname> -

# Preview the request without sending (for "show me the request")
meow push <nickname> "<message>" --dry-run

# Machine-readable result (recommended for agents)
meow push <nickname> "<message>" --json
```

The nickname can also be passed with `--nickname/-n`, or omitted after a default is configured: `meow push "<message>"`.

### Options

| Option | Description |
| --- | --- |
| `--title/-t` | Message title, defaults to `MeoW`; must not be empty |
| `--url/-u` | Link opened when the notification is tapped |
| `--img-url` | Notification icon URL; 216×216 PNG recommended |
| `--html` / `--text` / `--msg-type` | Message type, defaults to `text`; Markdown is not supported |
| `--html-height` | HTML display height in pixels; implies HTML type |
| `--method/-m get\|post` | Request method, defaults to `post`; see the GET limitation below |
| `--timeout` | HTTP timeout in seconds, defaults to 15 |
| `--dry-run` | Print the request without sending it |
| `--json` | Single-line JSON result on stdout |

> **GET limitation:** with `--method get`, the nickname, title, and message must not contain a slash `/`, or the server front end replies with HTTP 400. HTML closing tags (such as `</b>`) contain a slash, so HTML messages and messages containing links must use the default POST. The CLI rejects slashes before sending.

## Handling results

Even when the HTTP status is 200, parse the response JSON: the push succeeded only when `status == 200` and `data != false`.

`--json` output (also printed on failure; the exit code is then non-zero):

```json
{"ok":true,"status":200,"http_status":200,"msg":"...","data":true,"nickname":"Azathoth"}
```

Exit codes: `0` success; `1` business failure or network/parse error; `2` invalid usage.

| Business status | Meaning | Action |
| --- | --- | --- |
| 200 | Success | Report that the push was accepted |
| 400 | Invalid parameters | Fix the title/message/nickname and resend |
| 403 | Content blocked | Change the content; do not resend as-is |
| 404 | Nickname not registered | Confirm the nickname with the user; **never** probe with random nicknames (three wrong nicknames in one day get the IP banned) |
| 429 | Rate limited | Do not retry automatically; tell the user the limit and wait |
| 500 | Server error | Indeterminate; ask the user before resending |

**Never retry automatically.** 429 will keep failing; timeouts, connection errors, 500s, and non-JSON responses are indeterminate — the message may already have been delivered, so ask the user before resending.

## Rate limits and safety

- Regular users: **1 message per 3 seconds, 15 per minute, 60 per hour, 1000 per day**.
- Do not push in loops or in parallel; space out multiple messages and confirm each result.
- Do not bypass limits by rotating IPs or using proxies. Avoid sending to many different nicknames from a shared public IP; it may be flagged as an attack.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `command not found: meow` | Not installed; see Preflight |
| Transient connection/TLS failure | Occasional server hiccup; retry later, and remember the result may still be unknown |
| HTML 400 response | The GET path contains `/`; use the default POST |
| `ok:false, status:429` | Rate limited; wait before retrying |
| Recipient unclear | Stop and ask the user; do not guess nicknames |

## Reporting

Tell the user: **recipient nickname**, **whether the API accepted the push**, and **the server message**. On failure, include the business status code and reason. When the outcome is indeterminate, say so explicitly — do not claim the message was delivered.
