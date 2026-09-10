import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function artifactId(value) {
  if (idPattern.test(value)) return value.toLowerCase();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected a Claude Code artifact URL or UUID.");
  }
  const match = url.pathname.match(/^\/code\/artifact\/([^/]+)\/?$/);
  if (url.protocol !== "https:" || url.hostname !== "claude.ai" || !match || !idPattern.test(match[1])) {
    throw new Error("Expected a https://claude.ai/code/artifact/<UUID> URL.");
  }
  return match[1].toLowerCase();
}

async function oauthToken() {
  if (process.env["CLAUDE_CODE_OAUTH_TOKEN"]) return process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  try {
    if (process.platform === "darwin") {
      const result = await execFilePromise("security", ["find-generic-password", "-a", process.env["USER"], "-w", "-s", "Claude Code-credentials"], { encoding: "utf8", timeout: 10000 });
      return JSON.parse(result.stdout)["claudeAiOauth"]["accessToken"];
    }
    const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
    return JSON.parse(await readFile(join(configDir, ".credentials.json"), "utf8"))["claudeAiOauth"]["accessToken"];
  } catch {
    throw new Error("Reading Claude Code login: sign in with claude /login or set CLAUDE_CODE_OAUTH_TOKEN.");
  }
}

export function createArtifactClient({ baseUrl = process.env["CLAUDE_CODE_ARTIFACTS_API_BASE_URL"] ?? "https://api.anthropic.com", liveOrigin = "https://claude.ai", token = oauthToken } = {}) {
  async function request(method, path, body, signal) {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-type": "application/json",
        "X-Frame-CP": "go",
        "X-Frame-Surface": "code",
        "X-Frame-Platform": "cli",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} ${response.status}: expected JSON, received ${text.slice(0, 200)}`);
    }
    if (response.status === 409 && data?.conflict === true) throw new Error(`conflict: live version is ${data.live}`);
    if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${JSON.stringify(data)}`);
    return data;
  }

  return {
    request,
    async boot(id, signal) {
      const data = await request("GET", `/api/frame/${artifactId(id)}?via=model_read`, undefined, signal);
      if (typeof data?.subscriptionToken !== "string" || !data.subscriptionToken) {
        throw new Error(`Watching artifact ${id}: Claude did not issue a subscription token.`);
      }
      return data;
    },
    async comments(id, signal) {
      const data = await request("GET", `/api/frame/comments/${artifactId(id)}`, undefined, signal);
      if (!Array.isArray(data?.threads) || data.threads.some((thread) => !thread || typeof thread.id !== "string" || !Array.isArray(thread.comments) || thread.comments.some((comment) => !comment || typeof comment.id !== "string" || typeof comment.text !== "string"))) {
        throw new Error(`Listing comments for ${id}: invalid thread response.`);
      }
      return data;
    },
    socketUrl(id) {
      const url = new URL(`/edge-api/frame-live/${artifactId(id)}/ws`, liveOrigin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    },
  };
}

export const artifactClient = createArtifactClient();
