import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const archive = process.env.INKBOX_SDK_CANDIDATE_TGZ;
if (!archive)
  throw new Error(
    "Build the pinned SDK candidate before the installed-package proof.",
  );
const directory = mkdtempSync(join(tmpdir(), "inkbox-openclaw-package-"));
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
    encoding: "utf8",
  }),
);
const hostVersion = JSON.parse(
  readFileSync("node_modules/openclaw/package.json", "utf8"),
).version;
execFileSync(
  "npm",
  [
    "install",
    "--prefix",
    directory,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archive,
    join(directory, packed.filename),
    `openclaw@${hostVersion}`,
  ],
  { stdio: "inherit" },
);
const installed = join(directory, "node_modules/@inkbox/inkbox/package.json");
execFileSync(
  process.execPath,
  ["tests/ci/verify_candidate_sdk.mjs", installed],
  { stdio: "inherit" },
);
const entry = (
  await import(join(directory, "node_modules/@inkbox/inkbox/dist/index.js"))
).default;
if (entry.id !== "inkbox" || typeof entry.register !== "function")
  throw new Error("The packed native OpenClaw entry did not load.");
console.log(
  `Verified packed native plugin with OpenClaw ${hostVersion} and the real SDK candidate.`,
);
