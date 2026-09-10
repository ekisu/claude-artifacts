# claude-artifacts

Publish Claude Code artifacts from your terminal.

I love Claude Code artifacts. `claude-artifacts` exists because sharing and updating them should be as direct as creating them. Point it at local HTML, Markdown, YAML, CSV, JSON, source code, or another text file, get a Claude artifact URL, and keep updating that same URL without going back through chat.

## What You Can Do

- Publish local HTML, Markdown, data files, source files, and other text files as Claude Code artifacts.
- Update an existing artifact without changing its URL.
- List your Claude Code artifacts with URLs, owners, view counts, and the gallery link.
- Download the live artifact HTML when you need to inspect or archive it.
- List comment threads and replies, including their anchors and send state.
- Watch feedback sent from the artifact page and deliver it to an OpenCode V2 session over a live WebSocket.
- Expose the same workflow to Claude Code, Codex, Cursor, and other MCP-capable coding agents.

## Install

```sh
npm install -g claude-artifacts
```

If Claude Code is not logged in yet:

```sh
claude /login
```

## Quickstart

Publish a page:

```sh
claude-artifacts create dashboard.html --title "Launch dashboard"
```

Publish data or source files too:

```sh
claude-artifacts create config.yaml --title "Runtime config"
claude-artifacts create metrics.csv --title "Metrics export"
```

List your artifacts:

```sh
claude-artifacts list
```

Update the same artifact later:

```sh
claude-artifacts update <id> dashboard.html --title "Launch dashboard"
```

Download the live HTML:

```sh
claude-artifacts read <id> --content > deployed.html
```

Delete an artifact:

```sh
claude-artifacts delete <id>
```

## Output

`list` is built for quick scanning:

```text
gallery: https://claude.ai/code/artifacts

1. Launch dashboard
   id:      e2438a48-35b9-46bb-902e-fc59665782e2
   url:     https://claude.ai/code/artifact/e2438a48-35b9-46bb-902e-fc59665782e2
   updated: Jun 23, 2026, 2:28 PM CDT
   label:   launch-v1
   owner:   you@example.com
   access:  mine
   views:   8 total, 1 unique
```

Commands accept either the full Claude artifact URL or just the UUID:

```sh
claude-artifacts read https://claude.ai/code/artifact/<id>
claude-artifacts read <id>
```

## Commands

| Command | Purpose |
| --- | --- |
| `claude-artifacts create <file> [--title <title>] [--favicon <emoji>] [--label <label>]` | Publish a local file as a new artifact. |
| `claude-artifacts list [--limit <n>]` | Show your Claude Code artifacts and gallery URL. |
| `claude-artifacts read <artifact> [--content] [--content-version <version>]` | Read artifact metadata, or include HTML with `--content`. |
| `claude-artifacts comments <artifact>` | List comment threads and replies. Use `--output json` for full anchors, author details, resolution and send state returned by the API. |
| `claude-artifacts update <artifact> <file> [--title <title>] [--favicon <emoji>] [--label <label>] [--base-version <version>]` | Publish a new version to an existing artifact URL. |
| `claude-artifacts delete <artifact>` | Remove an artifact. |

`--favicon` is optional. It is a short text icon, usually an emoji, shown by Claude for the artifact.

### Comments

```sh
claude-artifacts comments <id>
claude-artifacts comments <id> --output json
```

Comment listing and watching use the existing Claude Code OAuth login. They do not attach to a browser or require web-session cookies. The frame API is undocumented and may change.

## OpenCode V2 feedback plugin

The plugin receives feedback submitted through the artifact page's **Send to Claude** action. An agent can publish a page, keep working, and receive your feedback automatically in the same conversation.

Build and install this fork locally:

```sh
npm ci
npm test
npm pack
# Install the generated tarball in your preferred persistent installation directory.
npm install --prefix ~/.local/share/claude-artifacts ./claude-artifacts-0.1.0.tgz
```

Add the installed plugin directory to `~/.config/opencode/opencode.jsonc` (replace `/home/me` with your home directory):

```jsonc
{
  "plugins": [
    "/home/me/.local/share/claude-artifacts/node_modules/claude-artifacts/dist/opencode"
  ],
  "mcp": {
    "servers": {
      "claude-artifacts": {
        "type": "local",
        "command": ["node", "/home/me/.local/share/claude-artifacts/node_modules/claude-artifacts/dist/claude-artifacts-mcp.mjs"]
      }
    }
  }
}
```

Merge these entries into your existing configuration. Both the plugin and the MCP process use the Claude Code login available to the OpenCode service. The plugin needs a V2 build with `ctx.tool.transform` and `ctx.session.synthetic`.

### Tools and workflow

| OpenCode tool | Purpose |
| --- | --- |
| `artifact_feedback_watch` | Start watching a URL or UUID for this session. Returns after connecting; no repeated tool calls are needed. |
| `artifact_feedback_unwatch` | Stop one artifact, or all watches in this session when `artifact` is omitted. |
| `artifact_feedback_status` | Show connection state, delivery counts, and errors without a network request. |

Tell OpenCode: **“Watch this artifact and work through feedback I send from the page.”**

- Successful `claude_artifacts__create` and `claude_artifacts__update` tool calls automatically start a watch. Set plugin option `autoWatchPublished: false` to disable this hook.
- A watch baselines existing submissions by default. Pass `include_existing: true` to also deliver already-sent feedback on unresolved threads.
- Only explicit sends and thread activations trigger feedback. Ordinary unsent comments and resolved threads do not.
- Feedback is admitted as a synthetic message with artifact, thread, and event provenance. It starts an idle agent or queues until current work reaches an idle boundary. It does not interrupt an active model call or change the session's model, agent, or permissions.
- Repeated signals are deduplicated. Resending a comment with a newer send timestamp produces new feedback. Failed admissions retry with a deterministic message ID and identical payload.
- Each session can watch up to five artifacts. Watches are session-scoped and stop on plugin unload/server shutdown. Call `watch` again after a restart. Explicit `unwatch` prevents a republish from restarting that watch during the plugin lifetime.
- The connection sends heartbeats, renews expiring subscription tokens, and reconnects with bounded backoff. Comment reads happen on change signals and reconnects, not on an idle polling interval. Repeated failures stop the watch and appear in `status`.

The plugin uses `GET /api/frame/<id>?via=model_read` to obtain a subscription token and opens `wss://claude.ai/edge-api/frame-live/<id>/ws` with the `frame-live.v1` subprotocol. On a comment-change signal it reads `/api/frame/comments/<id>` and compares `to_claude_at` and `claude_activated_at` timestamps. It does not mark comments resolved or send comments on your behalf.

The outgoing `send-to-claude` command from the initial fork implementation has been removed: receiving page submissions is handled by the plugin.

## MCP

Use the MCP server with Claude Code or any other coding agent that supports MCP stdio servers:

```sh
npx -y --package claude-artifacts claude-artifacts-mcp
```

Example MCP config:

```json
{
  "mcpServers": {
    "claude-artifacts": {
      "command": "npx",
      "args": ["-y", "--package", "claude-artifacts", "claude-artifacts-mcp"]
    }
  }
}
```

Available MCP tools:

```text
claude_artifacts__create
claude_artifacts__comments
claude_artifacts__list
claude_artifacts__read
claude_artifacts__update
claude_artifacts__delete
```

## How Login Works

`claude-artifacts` uses the same Claude Code login already on your machine. There is no separate API key to create or paste.
