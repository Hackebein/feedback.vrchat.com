import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "..");

await build({
  entryPoints: [path.join(root, "server/index.ts")],
  bundle: true,
  platform: "node",
  // Express and deps rely on dynamic require(); ESM bundle injects a shim that
  // breaks builtins like "path". CJS output runs under Node's real require().
  format: "cjs",
  target: "node20",
  outfile: path.join(root, "dist/server.cjs"),
});
