# n8n → Claude Code bridge

An Express server that lets n8n send a prompt to Claude Code and get back the
final text answer as JSON — no clipboard, no terminal window, no manual
copy/paste. It uses the official **Claude Agent SDK** instead of shelling out
to the `claude` CLI, which is what was causing the Windows spawn failures.

## Why `exec()` / `execFile()` / `spawn()` were failing

All three symptoms trace back to the same root cause: calling the `claude`
command as an external OS process on Windows.

- **`spawn claude ENOENT`** — `npm install -g @anthropic-ai/claude-code`
  installs `claude` on Windows as a `.cmd`/`.ps1` shim, not a `.exe`. Node's
  `child_process.spawn('claude', ...)` calls Windows' `CreateProcess`
  directly, which does **not** consult `PATHEXT` or resolve `.cmd`
  extensions the way `cmd.exe` does. Node can't find an executable literally
  named `claude`, so it reports `ENOENT` even though `claude` works fine
  when you type it into Command Prompt (where `cmd.exe` does the resolving
  for you).
- **`spawn EINVAL`** — this is what you get when Node is coerced into trying
  to execute the `.cmd` shim directly (e.g. by pointing `spawn()` at the
  resolved shim path without `shell: true`). A `.cmd` file isn't a valid
  Win32 executable image, so `CreateProcess` rejects it with `EINVAL`.
- **stdin timeout** — Claude Code's CLI is an interactive program by
  default; run without `-p`/`--print` (or with stdin left open and never
  closed) it waits on stdin expecting a terminal. A Node child process
  spawned from a server has no TTY, so the CLI sits there until whatever
  called it gives up.

The usual fixes (`shell: true`, `cross-spawn`, spawning `claude.cmd`
explicitly, manually closing stdin, adding `--print`) all work, but they're
exactly the kind of workaround you asked to avoid, and they still leave you
maintaining permission-prompt handling, JSON parsing of CLI output, and
process lifecycle by hand.

## Why the Claude Agent SDK instead

`@anthropic-ai/claude-agent-sdk` is Anthropic's officially supported way to
run Claude Code programmatically from Node.js/TypeScript. Two things make it
the right fit here, confirmed against the current SDK metadata (v0.3.215,
matching Claude Code v2.1.215):

1. **It ships its own binary per platform** as an optional dependency —
   `@anthropic-ai/claude-agent-sdk-win32-x64` on Windows x64,
   `@anthropic-ai/claude-agent-sdk-win32-arm64` on ARM64. `npm install`
   pulls in the right one automatically. The SDK spawns *that* binary
   internally, in a way it controls end-to-end, so none of the PATH/shim
   resolution problems that break a hand-rolled `spawn('claude')` apply.
2. **It's an async generator API**, not a text stream you have to parse.
   `query({ prompt, options })` yields typed `SDKMessage` objects
   (`system`, `assistant`, `result`, etc.) ending in a `result` message
   with the final answer, cost, and error state — no stdout scraping.

## What each dependency is for

| Package | Why it's here |
|---|---|
| `express` | HTTP server exposing `POST /claude` and `GET /health`. |
| `cors` | Lets n8n's browser-based editor and the n8n execution engine call this bridge from a different origin/port without the browser blocking the request. |
| `@anthropic-ai/claude-agent-sdk` | Official SDK that runs Claude Code in-process via its bundled binary. Replaces all direct `claude` CLI invocation. |
| `dotenv` | Loads `.env` into `process.env` so config (timeouts, working directory, permission mode) isn't hardcoded. |

No `child_process` calls anywhere in this project.

## Setup (Windows 11)

```powershell
git clone <this-repo>
cd n8n-claude-chatgpt
npm install
copy .env.example .env
```

Edit `.env`:

- Set `CLAUDE_CWD` to a real folder you want Claude Code to work in (e.g.
  `C:\claude-workspace`). This is the directory it can read/write files and
  run shell commands in.
- Leave `CLAUDE_PERMISSION_MODE=bypassPermissions` if you want it to run
  fully unattended (required for a headless server — there's no terminal to
  approve tool use). Only point `CLAUDE_CWD` at something you trust running
  arbitrary commands against when you do this. If you want tighter control,
  switch to `dontAsk` and configure `permissions.allow` rules for the
  specific tools you need instead.

Authentication: the bundled binary uses the same credential store as your
existing `claude login` session, so if `claude` already works from Command
Prompt on this machine, no extra auth step is needed. If you'll run this as
a Windows service under a different account (no interactive login session
available), set `ANTHROPIC_API_KEY` in `.env` instead.

Run it:

```powershell
npm start
```

You should see:

```
n8n-claude-bridge listening on http://0.0.0.0:3000
```

Verify it's alive:

```powershell
curl http://localhost:3000/health
curl -X POST http://localhost:3000/claude -H "Content-Type: application/json" -d "{\"prompt\":\"Say hello in one sentence.\"}"
```

## API

### `POST /claude`

Request:

```json
{ "prompt": "Write a function that reverses a string in Python." }
```

Success response (`200`):

```json
{ "success": true, "output": "...", "requestId": "..." }
```

Error responses (`400` bad input, `502` Claude Code returned an error,
`504` timed out, `500` unexpected failure) all use the same shape:

```json
{ "success": false, "error": "...", "requestId": "..." }
```

### `GET /health`

Returns `{ "status": "ok", "uptime": <seconds> }`. Use it as the liveness
check if you run this under a process manager (NSSM, PM2, Task Scheduler).

## Wiring it into n8n

Add an **HTTP Request** node:

- Method: `POST`
- URL: `http://localhost:3000/claude` (or the bridge's host if it's running
  elsewhere on your network)
- Body Content Type: `JSON`
- Body:
  ```json
  { "prompt": "{{ $json.prompt }}" }
  ```
- **Timeout**: n8n's HTTP Request node defaults to a timeout far shorter
  than a code-generation task can take. Raise it (Options → Timeout) to at
  least `REQUEST_TIMEOUT_MS` from your `.env`, e.g. 900000 (15 minutes).

The response lands in `{{ $json.output }}` for downstream nodes, and
`{{ $json.success }}` is available for an IF node to branch on failure.

## Production notes

- The server disables Node's default 5-minute socket timeout
  (`server.requestTimeout = 0`) and enforces its own ceiling via
  `AbortController` + `REQUEST_TIMEOUT_MS`, so long code-gen calls aren't
  killed mid-flight by the HTTP layer while still having a hard upper bound.
- `MAX_TURNS` bounds how many tool-call round trips a single request can
  take, as a backstop against runaway agent loops independent of the wall
  clock timeout.
- Run this behind a process manager (NSSM as a Windows service, or PM2) so
  it restarts on crash and starts on boot.
- `CLAUDE_CWD` is the blast radius: Claude Code can read, write, and execute
  within it. Don't point it at a directory you wouldn't want an autonomous
  agent making changes in.
