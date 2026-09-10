import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { defineCommand, defineGroup, S } from "toolcraft";
import { parse } from "toolcraft/design/parse";
import { renderHtml } from "toolcraft/design/render-html";
import { renderMarkdownHtml } from "toolcraft/design/render-markdown-html";

import { artifactClient, artifactId } from "./api.js";

const frameRequest = artifactClient.request;
const artifactCss = await readFile(new URL("./artifact.css", import.meta.url), "utf8");
const artifactsGalleryUrl = "https://claude.ai/code/artifacts";
const markdownHtmlOptions = { syntaxHighlight: true };
const codeLanguageByExtension = new Map([
  [".cjs", "js"],
  [".css", "css"],
  [".csv", "csv"],
  [".env", "sh"],
  [".js", "js"],
  [".json", "json"],
  [".jsonc", "jsonc"],
  [".jsx", "jsx"],
  [".log", "text"],
  [".mjs", "js"],
  [".py", "python"],
  [".rb", "ruby"],
  [".sh", "sh"],
  [".sql", "sql"],
  [".toml", "toml"],
  [".ts", "ts"],
  [".tsx", "tsx"],
  [".txt", "text"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);

function sourceKind(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  return "code";
}

function sourceLanguage(path) {
  const extension = extname(path).toLowerCase();
  if (extension === "") return "text";
  return codeLanguageByExtension.get(extension) ?? (extension.slice(1).replace(/[^a-z0-9_+-]/gi, "") || "text");
}

async function validateArtifactSource(file) {
  const path = resolve(file);
  const fileStat = await stat(path);
  const kind = sourceKind(path);
  const language = kind === "code" ? sourceLanguage(path) : undefined;
  return {
    path,
    kind,
    language,
    bytes: fileStat.size,
    under_size_limit: fileStat.size <= 16 * 1024 * 1024,
    publishable: fileStat.size <= 16 * 1024 * 1024,
  };
}

function pageHtml(bodyHtml) {
  return `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><style>${artifactCss}</style></head><body>\n${bodyHtml}\n</body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderFrontmatterValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    return `<table><tbody><tr>${value.map((item) => `<td>${renderFrontmatterValue(item)}</td>`).join("")}</tr></tbody></table>`;
  }
  if (value !== null && typeof value === "object") return renderNestedFrontmatterTable(value);
  if (value === null || value === undefined) return "";
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function renderNestedFrontmatterTable(frontmatter) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return "";
  const headers = entries.map(([key]) => `<th>${escapeHtml(key)}</th>`).join("");
  const values = entries.map(([, value]) => `<td>${renderFrontmatterValue(value)}</td>`).join("");
  return `<table><thead><tr>${headers}</tr></thead><tbody><tr>${values}</tr></tbody></table>`;
}

function renderFrontmatterTable(frontmatter) {
  if (frontmatter === undefined) return "";
  const rows = Object.entries(frontmatter)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${renderFrontmatterValue(value)}</td></tr>`)
    .join("");
  return rows === "" ? "" : `<table class="frontmatter"><tbody>${rows}</tbody></table>`;
}

function renderArtifactMarkdownHtml(source) {
  const { ast, frontmatter } = parse(source);
  return [renderFrontmatterTable(frontmatter), renderHtml(ast, markdownHtmlOptions)].filter(Boolean).join("\n");
}

function fencedMarkdown(source, language) {
  const longestBacktickRun = Math.max(2, ...[...source.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}${language}\n${source.replace(/\s*$/, "\n")}${fence}`;
}

async function artifactContent(path, kind, language) {
  const source = await readFile(path, "utf8");
  if (kind === "markdown") {
    return pageHtml(renderArtifactMarkdownHtml(source));
  }
  if (/<!doctype\s+html/i.test(source) || /<html[\s>]/i.test(source)) return source;
  if (kind === "html") return pageHtml(source);
  return pageHtml(renderMarkdownHtml(fencedMarkdown(source, language ?? "text"), markdownHtmlOptions));
}

async function artifactTitle(path, title) {
  if (title !== undefined) return title;
  return basename(path, extname(path));
}

async function artifactAssetContent(slug, version, assetToken) {
  const response = await fetch(`https://${slug}.frame.claudeusercontent.com/_f/${version}/?__frame_t=${encodeURIComponent(assetToken)}`, {
    redirect: "manual",
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) throw new Error(`asset ${response.status}: ${text.slice(0, 200)}`);
  return text.replace(`<base href="/_f/${version}/">`, "");
}

function artifactMetadata(slug, body) {
  return {
    artifact_url: `https://claude.ai/code/artifact/${slug}`,
    artifact_id: slug,
    title: body["title"],
    favicon: body["favicon"],
    version: body["ver"],
    live: body["live"],
    role: body["perm"]?.["role"],
    share_mode: body["perm"]?.["mode"],
    author_email: body["author"]?.["email"],
    created_at: body["created_at"],
    updated_at: body["updated_at"],
    history: body["history"],
    versions: body["versions"],
  };
}

async function publishDirect(path, kind, language, slug, title, favicon = "*", label, baseVersion) {
  const content = await artifactContent(path, kind, language);
  const body = {
    title: await artifactTitle(path, title),
    favicon,
    content,
    ...(slug !== undefined ? { slug } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  };
  const responseBody = await frameRequest("POST", "/api/frame/deploy/direct", body);
  const responseSlug = responseBody["slug"];
  const version = responseBody["version"];
  if (responseSlug === undefined || version === undefined) throw new Error(`deploy returned incomplete response: ${JSON.stringify(responseBody)}`);
  return {
    artifact_url: `https://claude.ai/code/artifact/${responseSlug}`,
    artifact_id: responseSlug,
    version,
    read: responseBody["read"],
    shared: responseBody["shared"],
  };
}

function renderJson(value) {
  return value;
}

function renderLines(lines) {
  return lines.filter((line) => line !== "").join("\n");
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function renderPublish(value) {
  return renderLines([
    `artifact: ${value.artifact_url}`,
    `source:   ${value.source_path}`,
    `version:  ${value.version}`,
  ]);
}

function renderRead(value) {
  return renderLines([
    `artifact: ${value.artifact_url}`,
    `title:    ${value.title}`,
    `version:  ${value.version}`,
    `role:     ${value.role}`,
    `updated:  ${value.updated_at}`,
    value.content_html !== undefined ? "" : "",
    value.content_html !== undefined ? "```html" : "",
    value.content_html !== undefined ? value.content_html : "",
    value.content_html !== undefined ? "```" : "",
  ]);
}

function renderList(value) {
  const galleryLine = `gallery: ${value.gallery_url}`;
  if (value.artifacts.length === 0) return renderLines([galleryLine, "no code artifacts"]);
  return renderLines([
    galleryLine,
    "",
    value.artifacts.map((artifact, index) => renderLines([
      `${index + 1}. ${artifact.title ?? "(untitled)"}`,
      `   id:      ${artifact.artifact_id}`,
      `   url:     ${artifact.artifact_url}`,
      `   updated: ${artifact.updated_at_display}`,
      artifact.label !== undefined ? `   label:   ${artifact.label}` : "",
      `   owner:   ${artifact.owner_email}`,
      `   access:  ${artifact.relation}`,
      `   views:   ${artifact.view_count} total, ${artifact.unique_view_count} unique`,
    ])).join("\n\n"),
  ]);
}

function renderDelete(value) {
  return `deleted: ${value.artifact_url}`;
}

const publishParams = {
  file: S.String({ description: "Local HTML, Markdown, or text/code data file to publish." }),
  favicon: S.Optional(S.String({ description: "One or two emoji for the artifact browser-tab icon. Defaults to *." })),
  title: S.Optional(S.String({ description: "Artifact title. Defaults to the file basename." })),
  label: S.Optional(S.String({ description: "Version label shown in the artifact version picker." })),
};

const createCommand = defineCommand({
  name: "create",
  aliases: ["publish"],
  description: "Publish a new Claude Code artifact from a local file using the current Claude Code login without an LLM turn.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["file"],
  params: S.Object(publishParams),
  handler: async ({ params }) => {
    const validation = await validateArtifactSource(params.file);
    if (!validation.publishable) throw new Error(`Artifact source is not publishable: ${validation.path}`);
    const published = await publishDirect(validation.path, validation.kind, validation.language, undefined, params.title, params.favicon, params.label, undefined);
    return { ...published, source_path: validation.path };
  },
  render: { json: renderJson, markdown: renderPublish, rich: (value, primitives) => primitives.logger.message(renderPublish(value), "") },
});

const updateCommand = defineCommand({
  name: "update",
  description: "Publish a new version of an existing Claude Code artifact from a local file.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["artifact", "file"],
  params: S.Object({
    artifact: S.String({ description: "Claude Code artifact URL or artifact ID." }),
    baseVersion: S.Optional(S.String({ description: "Version to overwrite from. Pass the current version when enforcing conflict checks." })),
    ...publishParams,
  }),
  handler: async ({ params }) => {
    const validation = await validateArtifactSource(params.file);
    if (!validation.publishable) throw new Error(`Artifact source is not publishable: ${validation.path}`);
    const published = await publishDirect(validation.path, validation.kind, validation.language, artifactId(params.artifact), params.title, params.favicon, params.label, params.baseVersion);
    return { ...published, artifact_id: artifactId(params.artifact), source_path: validation.path };
  },
  render: { json: renderJson, markdown: renderPublish, rich: (value, primitives) => primitives.logger.message(renderPublish(value), "") },
});

const readCommand = defineCommand({
  name: "read",
  description: "Read a Claude Code artifact from the Claude frame API.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["artifact"],
  params: S.Object({
    artifact: S.String({ description: "Claude Code artifact URL or artifact ID." }),
    content: S.Optional(S.Boolean({ description: "Include current HTML content." })),
    contentVersion: S.Optional(S.String({ description: "Artifact version to fetch when content is included." })),
  }),
  handler: async ({ params }) => {
    const id = artifactId(params.artifact);
    const response = await frameRequest("GET", `/api/frame/${id}`, undefined);
    const metadata = artifactMetadata(id, response);
    if (params.content !== true) return metadata;
    const version = params.contentVersion ?? response["ver"];
    const content = await artifactAssetContent(id, version, response["assetToken"]);
    return { ...metadata, version, content_html: content, content_bytes: Buffer.byteLength(content, "utf8") };
  },
  render: { json: renderJson, markdown: renderRead, rich: (value, primitives) => primitives.logger.message(renderRead(value), "") },
});

const listCommand = defineCommand({
  name: "list",
  description: "List Claude Code artifacts from the Claude frame API.",
  scope: ["cli", "mcp", "sdk"],
  params: S.Object({
    limit: S.Optional(S.Number({ description: "Maximum number of artifacts to request." })),
  }),
  handler: async ({ params }) => {
    const response = await frameRequest("GET", `/api/frame/frames?limit=${params.limit ?? 60}`, undefined);
    const artifacts = response["frames"]
      .filter((frame) => frame["source_surface"] === "code")
      .map((frame) => ({
        artifact_url: `https://claude.ai/code/artifact/${frame["slug"]}`,
        artifact_id: frame["slug"],
        title: frame["title"],
        label: frame["label"],
        owner_email: frame["owner_email"],
        owner_account: frame["owner_account"],
        relation: frame["rel"],
        source_surface: frame["source_surface"],
        view_count: frame["view_count"],
        unique_view_count: frame["unique_view_count"],
        updated_at: frame["updatedAt"],
        updated_at_display: formatTimestamp(frame["updatedAt"]),
      }));
    return { gallery_url: artifactsGalleryUrl, artifacts };
  },
  render: { json: renderJson, markdown: renderList, rich: (value) => process.stdout.write(`${renderList(value)}\n`) },
});

function renderComments(value) {
  return renderLines([
    `artifact: ${value.artifact_url}`,
    value.threads.length === 0 ? "no comments" : "",
    ...value.threads.map((thread) => renderLines([
      `thread: ${thread.id}${thread.resolved_at ? " (resolved)" : ""}`,
      thread.anchor?.label ? `   anchor: ${thread.anchor.label}` : "",
      ...thread.comments.map((comment) => `   ${comment.id} · ${comment.author?.name ?? comment.author?.account ?? "unknown"} · ${comment.created_at}\n   ${comment.text}`),
    ])),
  ]);
}

const commentsCommand = defineCommand({
  name: "comments",
  description: "List artifact comment threads, replies, anchors, and send state.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["artifact"],
  params: S.Object({
    artifact: S.String({ description: "Claude Code artifact URL or artifact ID." }),
  }),
  handler: async ({ params }) => {
    const id = artifactId(params.artifact);
    const response = await artifactClient.comments(id);
    return { ...response, artifact_id: id, artifact_url: `https://claude.ai/code/artifact/${id}` };
  },
  render: { json: renderJson, markdown: renderComments, rich: (value) => process.stdout.write(`${renderComments(value)}\n`) },
});

const deleteCommand = defineCommand({
  name: "delete",
  description: "Delete a Claude Code artifact.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["artifact"],
  params: S.Object({
    artifact: S.String({ description: "Claude Code artifact URL or artifact ID." }),
  }),
  handler: async ({ params }) => {
    const id = artifactId(params.artifact);
    await frameRequest("DELETE", `/api/frame/${id}`, undefined);
    return { deleted: true, artifact_id: id, artifact_url: `https://claude.ai/code/artifact/${id}` };
  },
  render: { json: renderJson, markdown: renderDelete, rich: (value, primitives) => primitives.logger.message(renderDelete(value), "") },
});

export const root = defineGroup({
  name: "claude-artifacts",
  description: "Create Claude Code artifacts with the current Claude Code login.",
  scope: ["cli", "mcp", "sdk"],
  children: [
    createCommand,
    readCommand,
    updateCommand,
    listCommand,
    commentsCommand,
    deleteCommand,
  ],
});
