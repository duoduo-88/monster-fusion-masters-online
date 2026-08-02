import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const localGame = resolve(root, "..", "outputs", "competitive-rule.html");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "public"), dist, { recursive: true });

await build({
  entryPoints: [resolve(root, "client", "lobby.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: resolve(dist, "lobby.js")
});

await build({
  entryPoints: [resolve(root, "client", "game-online.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: resolve(dist, "game-online.js")
});

let gameHtml = await readFile(localGame, "utf8");
gameHtml = gameHtml
  .replaceAll("../online/public/fonts/VT323-Regular.ttf", "./fonts/VT323-Regular.ttf")
  .replace("</head>", '<link rel="stylesheet" href="./online-game.css"></head>')
  .replace("</body>", '<script src="./config.js"></script><script type="module" src="./game-online.js"></script></body>');
await writeFile(resolve(dist, "game.html"), gameHtml, "utf8");

console.log("Online client built in dist/");
