import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const testDir = join(import.meta.dir, "..", "test");
const allTestFiles = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts") && f !== "offline-fases-abcd-e2e.test.ts")
  .map((f) => join("test", f));

const result = spawnSync(process.execPath, ["test", ...allTestFiles], {
  stdio: "inherit",
  cwd: join(import.meta.dir, ".."),
});

process.exit(result.status ?? 0);
