import { chmod, copyFile, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: {
    "claude-artifacts": "bin/claude-artifacts.mjs",
    "claude-artifacts-mcp": "bin/claude-artifacts-mcp.mjs",
    "opencode/index": "src/opencode.js",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  external: [
    "@modelcontextprotocol/sdk/inMemory.js",
    "@modelcontextprotocol/sdk/server/index.js",
    "@modelcontextprotocol/sdk/types.js",
    "bufferutil",
    "utf-8-validate",
  ],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: "bundle-process-runner-ignore",
      setup(buildContext) {
        buildContext.onLoad({ filter: /@poe-code\/process-runner\/dist\/docker\/build-context\.js$/ }, async (args) => {
          const contents = String(await readFile(args.path)).replace(
            'import { createRequire } from "node:module";\nimport path from "node:path";\nconst require = createRequire(import.meta.url);\nconst createIgnore = require("ignore");',
            'import createIgnore from "ignore";\nimport path from "node:path";',
          );
          return { contents, loader: "js" };
        });
      },
    },
  ],
});

await chmod("dist/claude-artifacts.mjs", 0o755);
await chmod("dist/claude-artifacts-mcp.mjs", 0o755);
await copyFile("src/artifact.css", "dist/artifact.css");
await copyFile("opencode/package.json", "dist/opencode/package.json");
