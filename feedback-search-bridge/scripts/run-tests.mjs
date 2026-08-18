import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, "..");
const tsxBin = join(root, "node_modules", ".bin", "tsx");

const files = (await readdir(scriptsDir))
  .filter((name) => name.startsWith("test-") && name.endsWith(".ts"))
  .sort((a, b) => {
    const aNet = a.includes("integration");
    const bNet = b.includes("integration");
    if (aNet !== bNet) {
      return aNet ? 1 : -1;
    }
    return a.localeCompare(b);
  });

if (files.length === 0) {
  console.error("No scripts/test-*.ts files found");
  process.exit(1);
}

for (const file of files) {
  const result = spawnSync(tsxBin, [join(scriptsDir, file)], {
    stdio: "inherit",
    cwd: root,
  });
  if (result.status !== 0) {
    console.error(`${file} failed (exit ${result.status ?? "signal"})`);
    process.exit(result.status ?? 1);
  }
}

console.info(`${files.length} test files passed`);
