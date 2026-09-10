import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = resolve(root, process.env["CLAUDE_ARTIFACTS_MCP_TEST_BIN"] ?? "bin/claude-artifacts-mcp.mjs");
const child = bin.endsWith(".mjs") ? spawn(process.execPath, [bin], { cwd: root, env: process.env }) : spawn(bin, [], { cwd: root, env: process.env });
const responses = new Map();
let stdout = "";
let stderr = "";

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  for (;;) {
    const newline = stdout.indexOf("\n");
    if (newline === -1) break;
    const line = stdout.slice(0, newline);
    stdout = stdout.slice(newline + 1);
    const message = JSON.parse(line);
    responses.set(message.id, message);
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

function write(id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function waitFor(id) {
  return new Promise((resolvePromise, rejectPromise) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(interval);
        resolvePromise(responses.get(id));
      } else if (Date.now() - start > 5000) {
        clearInterval(interval);
        rejectPromise(new Error(stderr || `missing response ${id}`));
      }
    }, 10);
  });
}

write(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-artifacts-smoke", version: "0.0.0" } });
const initialized = await waitFor(1);
if (initialized.result.serverInfo.name !== "claude-artifacts") throw new Error("server name mismatch");

child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
write(2, "tools/list", {});
const listed = await waitFor(2);
const names = listed.result.tools.map((tool) => tool.name).sort();
const expected = [
  "claude_artifacts__comments",
  "claude_artifacts__create",
  "claude_artifacts__delete",
  "claude_artifacts__list",
  "claude_artifacts__read",
  "claude_artifacts__update",
];
if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`tools ${JSON.stringify(names)}`);

child.stdin.end();
await new Promise((resolvePromise) => child.on("close", resolvePromise));

console.log(JSON.stringify({ ok: true, tools: names }, null, 2));
