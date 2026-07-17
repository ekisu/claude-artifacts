import { spawn } from "node:child_process";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = resolve(root, process.env["CLAUDE_ARTIFACTS_TEST_BIN"] ?? "bin/claude-artifacts.mjs");
const requests = [];
const artifactId = "11111111-1111-4111-8111-111111111111";
let versionIndex = 0;
let deleted = false;

const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const parsedBody = body === "" ? null : JSON.parse(body);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: parsedBody });
    response.setHeader("content-type", "application/json");
    response.setHeader("connection", "close");
    if (request.method === "POST" && request.url === "/api/frame/deploy/direct") {
      versionIndex += 1;
      response.end(JSON.stringify({ slug: parsedBody.slug ?? artifactId, version: `version-${versionIndex}`, read: "owner", shared: false }));
    } else if (request.method === "GET" && request.url === "/api/frame/frames?limit=60") {
      response.end(JSON.stringify({ frames: deleted ? [] : [{ slug: artifactId, title: "Smoke Artifact", label: "smoke", owner_account: "acct", owner_email: "owner@example.com", source_surface: "code", rel: "mine", view_count: 2, unique_view_count: 1, updatedAt: "2026-06-23T19:28:14Z" }], thumbsEnabled: false }));
    } else if (request.method === "GET" && request.url === `/api/frame/${artifactId}`) {
      response.end(JSON.stringify({ ver: `version-${versionIndex}`, assetToken: "asset-token", title: "Smoke Artifact", favicon: "*", perm: { role: "owner", mode: "owner" }, author: { email: "owner@example.com" }, created_at: "2026-06-23T19:28:14Z", updated_at: "2026-06-23T19:28:14Z", live: `version-${versionIndex}`, history: ["version-1"], versions: { "version-1": { title: "Smoke Artifact" } } }));
    } else if (request.method === "DELETE" && request.url === `/api/frame/${artifactId}`) {
      deleted = true;
      response.statusCode = 204;
      response.end("");
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: `${request.method} ${request.url}` }));
    }
  });
});

await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));

function run(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [bin, ...args, "--output", "json"], {
      cwd: root,
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: "fake-token",
        CLAUDE_CODE_ARTIFACTS_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) rejectPromise(new Error(`${args.join(" ")} failed\n${stdout}\n${stderr}`));
      else resolvePromise(JSON.parse(stdout));
    });
  });
}

function requireIncludes(content, needle, message) {
  if (!content.includes(needle)) throw new Error(message);
}

function requireToken(content, token, message) {
  requireIncludes(content, `class="tc-token-${token}"`, message);
}

function includesHighlightedSpan(content) {
  return content.includes('<span class="tc-token-');
}

const created = await run(["create", "test/smoke.html", "--title", "Smoke Artifact"]);
if (created.artifact_id !== artifactId) throw new Error(`create id ${created.artifact_id}`);
const htmlDeploy = requests.at(-1).body;
requireIncludes(htmlDeploy.content, "<h1>Smoke Artifact</h1>", "html body not uploaded");

await run(["create", "test/smoke.md", "--title", "Smoke Markdown"]);
const markdownDeploy = requests.at(-1).body;
requireIncludes(markdownDeploy.content, "max-width: 760px", "artifact css not bundled");
requireIncludes(markdownDeploy.content, "font: 14px/1.5 ui-rounded", "referenced artifact font style missing");
requireIncludes(markdownDeploy.content, ".tc-token-keyword", "syntax highlight css not bundled");
requireIncludes(markdownDeploy.content, '<table class="frontmatter"><tbody>', "frontmatter table not rendered");
requireIncludes(markdownDeploy.content, "<th>title</th><td>Smoke &amp; Markdown</td>", "frontmatter scalar not rendered");
requireIncludes(markdownDeploy.content, "<th>tags</th><td><table><tbody><tr><td>alpha</td><td>beta</td></tr></tbody></table></td>", "frontmatter array not rendered");
requireIncludes(markdownDeploy.content, "<th>draft</th><td>false</td>", "frontmatter boolean not rendered");
requireIncludes(markdownDeploy.content, "<th>details</th><td><table class=\"frontmatter\"><tbody><tr><th>owner</th><td>&lt;team&gt;</td>", "nested frontmatter not escaped");
requireIncludes(markdownDeploy.content, "<h1>Smoke Markdown</h1>", "markdown heading not rendered");
requireIncludes(markdownDeploy.content, "<ul><li>alpha</li><li>beta</li></ul>", "markdown list not rendered");
requireIncludes(markdownDeploy.content, '<code class="language-ts">', "markdown code fence language missing");
requireToken(markdownDeploy.content, "keyword", "markdown code keyword token missing");
requireToken(markdownDeploy.content, "type", "markdown code type token missing");
requireToken(markdownDeploy.content, "boolean", "markdown code boolean token missing");

await run(["create", "test/smoke.yaml", "--title", "Smoke YAML"]);
const yamlDeploy = requests.at(-1).body;
requireIncludes(yamlDeploy.content, '<code class="language-yaml">', "yaml fence language missing");
requireToken(yamlDeploy.content, "key", "yaml key token missing");
requireIncludes(yamlDeploy.content, "  - alpha", "yaml content missing");

await run(["create", "test/smoke.csv", "--title", "Smoke CSV"]);
const csvDeploy = requests.at(-1).body;
requireIncludes(csvDeploy.content, '<code class="language-csv">', "csv fence language missing");
requireIncludes(csvDeploy.content, "name,count\nalpha,1", "csv content missing");
if (includesHighlightedSpan(csvDeploy.content)) throw new Error("csv should render as plain escaped code");

await run(["create", "test/smoke.json", "--title", "Smoke JSON"]);
const jsonDeploy = requests.at(-1).body;
requireIncludes(jsonDeploy.content, '<code class="language-json">', "json fence language missing");
requireToken(jsonDeploy.content, "key", "json key token missing");
requireToken(jsonDeploy.content, "string", "json string token missing");
requireToken(jsonDeploy.content, "boolean", "json boolean token missing");
requireIncludes(jsonDeploy.content, "&quot;enabled&quot;", "json content not escaped");

await run(["create", "test/smoke.js", "--title", "Smoke JS"]);
const jsDeploy = requests.at(-1).body;
requireIncludes(jsDeploy.content, '<code class="language-js">', "js fence language missing");
requireToken(jsDeploy.content, "keyword", "js keyword token missing");
requireToken(jsDeploy.content, "string", "js string token missing");
requireIncludes(jsDeploy.content, "&lt;safe&gt;", "js content not escaped");

await run(["create", "test/smoke.txt", "--title", "Smoke Text"]);
const textDeploy = requests.at(-1).body;
requireIncludes(textDeploy.content, '<code class="language-text">', "text fence language missing");
requireIncludes(textDeploy.content, 'console.log(&quot;nested&quot;);', "nested code fence content not escaped");
if (includesHighlightedSpan(textDeploy.content)) throw new Error("text should render as plain escaped code");

const read = await run(["read", artifactId]);
if (read.title !== "Smoke Artifact") throw new Error(`read title ${read.title}`);
const updated = await run(["update", artifactId, "test/smoke.html", "--title", "Smoke Artifact Updated", "--base-version", created.version]);
if (updated.version !== "version-8") throw new Error(`update version ${updated.version}`);
const listed = await run(["list"]);
if (listed.artifacts.length !== 1 || listed.artifacts[0].artifact_id !== artifactId) throw new Error("list missing artifact");
if (listed.gallery_url !== "https://claude.ai/code/artifacts") throw new Error(`gallery ${listed.gallery_url}`);
const removed = await run(["delete", artifactId]);
if (removed.deleted !== true) throw new Error("delete failed");
const afterDelete = await run(["list"]);
if (afterDelete.artifacts.length !== 0) throw new Error("deleted artifact still listed");
if (!requests.every((request) => request.headers.authorization === "Bearer fake-token")) throw new Error("auth header missing");

server.closeAllConnections?.();
await new Promise((resolvePromise) => server.close(resolvePromise));

console.log(JSON.stringify({ ok: true, requests: requests.length }, null, 2));
process.exit(0);
