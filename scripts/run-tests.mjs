// Reviewed DevMesh Factory test runner: Node's own test runner over every test/**/*.test.ts, failing unless at least one test ran and
// every test passed. Its last line, "Tests N passed (N)", is what the factory's checks look for.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = readdirSync("test", { recursive: true })
  .map((f) => join("test", String(f)))
  .filter((f) => f.endsWith(".test.ts"))
  .sort();
if (files.length === 0) {
  console.error("run-tests: no test files under test/");
  process.exit(1);
}
const run = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=tap", ...files], { encoding: "utf8" });
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
const count = (name) => Number((run.stdout ?? "").match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? NaN);
const tests = count("tests");
const pass = count("pass");
if (run.status !== 0 || !(tests > 0) || pass !== tests) {
  console.error(`run-tests: failed (exit ${run.status}, ${pass} of ${tests} passed)`);
  process.exit(1);
}
console.log(`Tests ${pass} passed (${tests})`);
