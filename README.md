# MeoW Push

A Rust CLI plus an agent skill for pushing messages to MeoW nicknames via the [MeoW Push API](https://www.chuckfang.com/MeoW/api_doc.html) (`api.chuckfang.com`).

- **`cli/`** — the `meow` command-line tool
- **`SKILL.md`** — agent instructions for using the CLI safely and correctly
- **`references/api.md`** — offline API reference

## Features

- POST JSON by default (robust path handling); GET is also supported
- Text/HTML messages, title, tap-through link, notification icon, HTML display height
- Long messages via stdin
- `--dry-run` to preview a request, `--json` for machine-readable output
- Default nickname via config file (`~/.config/meow/config.toml`)
- Business status parsing with actionable hints (`400/403/404/429/500`)
- No automatic retries (the API is not idempotent)

## Install

```bash
cargo install --path cli --locked
```

Or just build:

```bash
cargo build --release --manifest-path cli/Cargo.toml
./cli/target/release/meow --help
```

### Static build (musl)

A fully static binary (no glibc dependency) can be built with the musl target:

```bash
# Arch Linux prerequisites
sudo pacman -S musl rust-musl

cargo build --release --target x86_64-unknown-linux-musl --manifest-path cli/Cargo.toml
# -> cli/target/x86_64-unknown-linux-musl/release/meow
#    static-pie linked, stripped, ~4.7 MB
```

`cli/.cargo/config.toml` sets `CC_x86_64_unknown_linux_musl=musl-gcc` so the C code in `ring` (rustls crypto backend) compiles against musl. Install the static binary system-wide with:

```bash
cargo install --path cli --target x86_64-unknown-linux-musl --locked
```

## Quick start

```bash
# Basic usage (POST JSON by default)
meow push Azathoth "Deployment finished"

# Title + link + icon
meow push Azathoth "Build passed" --title "CI" \
  --url "https://ci.example.com/build/42" \
  --img-url "https://example.com/icon_216x216.png"

# HTML message
meow push Azathoth "<b>Build passed</b>" --html --html-height 300

# Long / multi-line message
printf '%s' "$LONG_TEXT" | meow push Azathoth -

# Preview without sending
meow push Azathoth "hello" --dry-run

# JSON output
meow push Azathoth "hello" --json
# {"ok":true,"status":200,"http_status":200,"msg":"发送成功","data":true,"nickname":"Azathoth"}
```

Set a default nickname and omit it later:

```bash
meow config set nickname Azathoth
meow push "hello"
meow config            # show configuration
meow config set title "My notifications"
```

## Usage

```text
meow push [OPTIONS] [NICKNAME] <MSG>
meow config [set <KEY> <VALUE>]
```

`MSG` may be `-` to read from stdin. Nickname resolution order: positional argument > `--nickname` > `MEOW_NICKNAME` > config file.

| Option | Description |
| --- | --- |
| `-n, --nickname <NAME>` | Recipient nickname |
| `-t, --title <TITLE>` | Title, defaults to `MeoW` |
| `-u, --url <URL>` | Link opened when the notification is tapped |
| `--img-url <URL>` | Notification icon (216×216 PNG recommended) |
| `--html` / `--text` | Message type, defaults to `text` |
| `--msg-type <text\|html>` | Explicit message type |
| `--html-height <PX>` | HTML display height (implies HTML type) |
| `-m, --method <get\|post>` | Request method, defaults to `post` |
| `--timeout <SECONDS>` | HTTP timeout, defaults to 15 |
| `--dry-run` | Print the request without sending |
| `--json` | Single-line JSON output |
| `--base-url <URL>` | Override the API base URL (env: `MEOW_BASE_URL`) |

Environment variables: `MEOW_NICKNAME`, `MEOW_BASE_URL`.

## Results and exit codes

The API normally returns HTTP 200; the business result is in the JSON body: `{"status":200,"data":true,"msg":"发送成功"}`.

- Exit code `0`: success (`status=200` and `data != false`)
- Exit code `1`: business failure or network/parse error
- Exit code `2`: invalid usage

Business status codes: `400` invalid parameters, `403` content blocked, `404` nickname not registered, `429` rate limited, `500` server error. In `--json` mode an extra `hint` field suggests how to proceed.

## Safety notes

- **GET limitation:** GET path segments must not contain `/` (the server rejects `%2F` with HTTP 400). HTML closing tags contain `/`, so use the default POST for HTML messages.
- **No automatic retries:** pushes are not idempotent; timeouts, connection drops, 500s, and non-JSON responses may still have been delivered.
- **Rate limits** (regular users): 1 per 3 seconds, 15 per minute, 60 per hour, 1000 per day.
- **Never probe with random nicknames:** three sends to unregistered nicknames in one day get the IP banned.
- Avoid pushing to many nicknames from a shared public IP.

## Agent skill

`SKILL.md` follows the agent-skill convention (frontmatter + instructions, with the API reference under `references/`, and Codex UI metadata under `agents/`).

Install it into your agent's skills directory, for example:

```bash
# Claude/Pi-style skills directory
ln -s "$(pwd)" ~/.agents/skills/meow-push
# Codex
ln -s "$(pwd)" ~/.codex/skills/meow-push
```

## Repository layout

```text
.
├── SKILL.md                 # agent instructions
├── README.md
├── references/
│   └── api.md               # offline API reference
├── agents/
│   └── openai.yaml          # Codex UI metadata
└── cli/
    ├── .cargo/
    │   └── config.toml      # musl static build settings
    ├── Cargo.toml
    ├── Cargo.lock
    └── src/main.rs          # CLI implementation + tests
```

## Development

```bash
cargo test --manifest-path cli/Cargo.toml
# 5 tests: URL encoding, body construction, GET slash rejection, local mock end-to-end
cargo clippy --manifest-path cli/Cargo.toml
```
