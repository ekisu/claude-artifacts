# claude-artifacts

Publish Claude Code artifacts from your terminal.

I love Claude Code artifacts. `claude-artifacts` exists because sharing and updating them should be as direct as creating them. Point it at local HTML, Markdown, YAML, CSV, JSON, source code, or another text file, get a Claude artifact URL, and keep updating that same URL without going back through chat.

## What You Can Do

- Publish local HTML, Markdown, data files, source files, and other text files as Claude Code artifacts.
- Update an existing artifact without changing its URL.
- List your Claude Code artifacts with URLs, owners, view counts, and the gallery link.
- Download the live artifact HTML when you need to inspect or archive it.
- List comment threads and replies, including their anchors and send state.
- Send all eligible open comments to Claude using the artifact page's Send all action.
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
| `claude-artifacts send-to-claude <artifact>` | Send all eligible open comments to Claude and return the send count, timestamp, and listener count when available. |
| `claude-artifacts update <artifact> <file> [--title <title>] [--favicon <emoji>] [--label <label>] [--base-version <version>]` | Publish a new version to an existing artifact URL. |
| `claude-artifacts delete <artifact>` | Remove an artifact. |

`--favicon` is optional. It is a short text icon, usually an emoji, shown by Claude for the artifact.

### Comments

```sh
claude-artifacts comments <id>
claude-artifacts comments <id> --output json
claude-artifacts send-to-claude <id>
```

`send-to-claude` changes comment send state. It uses the same bulk endpoint as the page's **Send all** action; it does not create a comment or wait for a Claude response. A successful send is not a guarantee that an agent is connected or will respond. The server decides which comments are eligible and may reject sending based on artifact permissions or feature availability.

`comments` uses the existing Claude Code OAuth login. **Experimental:** `send-to-claude` requires the environment variables `CLAUDE_AI_SESSION_KEY` (the value of your claude.ai `sessionKey` cookie) and `CLAUDE_AI_ORG_ID` (your Claude organization UUID). Configure these privately in the CLI or MCP server environment; do not put them in command arguments or commit them. The command calls claude.ai directly and does not attach to or extract credentials from a browser.

Comment listing has been verified against the live API. Sending is covered by local request-contract tests; live OAuth sending was rejected by Claude because the action requires a web session, and the web-session path has not been verified live. The frame API is undocumented and may change.

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
claude_artifacts__send_to_claude
claude_artifacts__update
claude_artifacts__delete
```

## How Login Works

`claude-artifacts` uses the same Claude Code login already on your machine. There is no separate API key to create or paste.
