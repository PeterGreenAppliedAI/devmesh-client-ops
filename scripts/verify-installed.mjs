// Reviewed DevMesh Factory check: every package the lockfile requires on this platform is installed at its locked version.
// An entry whose os, cpu or libc excludes this platform may be absent; every other entry, optional or not, must be present.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const glibc = process.platform === "linux" ? Boolean(process.report?.getReport?.().header?.glibcVersionRuntime) : null;
const libc = glibc === null ? null : glibc ? "glibc" : "musl";
const matches = (list, value) => {
  if (!Array.isArray(list) || list.length === 0 || value === null) return true;
  const denied = list.filter((x) => x.startsWith("!")).map((x) => x.slice(1));
  const allowed = list.filter((x) => !x.startsWith("!"));
  return !denied.includes(value) && (allowed.length === 0 || allowed.includes(value));
};
const problems = [];
let checked = 0;
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === "") continue;
  if (!matches(entry.os, process.platform) || !matches(entry.cpu, process.arch) || !matches(entry.libc, libc)) continue;
  checked += 1;
  const manifest = join(path, "package.json");
  if (!existsSync(manifest)) {
    problems.push(`${path}: not installed`);
    continue;
  }
  const version = JSON.parse(readFileSync(manifest, "utf8")).version;
  if (version !== entry.version) problems.push(`${path}: ${version} installed, ${entry.version} locked`);
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`verify-installed: ${checked} package(s) installed as locked for ${process.platform}/${process.arch}`);
