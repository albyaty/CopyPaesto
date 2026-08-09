import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(appRoot, "release");
const previewRoot = join(appRoot, "dist");
let html = await readFile(join(appRoot, "index.html"), "utf8");
const result = await build({
  entryPoints: [join(appRoot, "src", "main.ts")],
  bundle: true,
  write: false,
  outdir: "out",
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  charset: "utf8",
});
const scriptFile = result.outputFiles.find((file) => file.path.endsWith(".js"));
const styleFile = result.outputFiles.find((file) => file.path.endsWith(".css"));
if (!scriptFile || !styleFile) throw new Error("Could not bundle the direct-transfer app");
const script = scriptFile.text.replace(/<\/script/gi, "<\\/script");
const style = styleFile.text.replace(/<\/style/gi, "<\\/style");
html = html.replace(/<script[^>]+src="[^"]+"[^>]*><\/script>/, `<script data-copypaesto-app>${script}</script>`);
html = html.replace("</head>", `  <style data-copypaesto-style>${style}</style>\n  </head>`);

html = html.replace("</head>", "  <meta name=\"copypaesto-build\" content=\"single-file\" />\n  </head>");
await mkdir(releaseRoot, { recursive: true });
await mkdir(previewRoot, { recursive: true });
await writeFile(join(releaseRoot, "CopyPaesto-Direct.html"), html, "utf8");
await writeFile(join(previewRoot, "index.html"), html, "utf8");

console.log("Built release/CopyPaesto-Direct.html (self-contained offline app)");
