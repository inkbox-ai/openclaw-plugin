import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const location = process.argv[2] ?? join(process.cwd(), "package.json");
const require = createRequire(location);
const transport = require.resolve("@inkbox/sdk/tunnels/connect");
const packageRoot = resolve(dirname(transport), "../../..");
const entry = join(packageRoot, "dist/index.js");
const manifest = JSON.parse(
  readFileSync(join(dirname(entry), "..", "package.json"), "utf8"),
);
const [major, minor, patch] = manifest.version.split(".").map(Number);
const supportedVersion = major === 0 && (minor > 7 || (minor === 7 && patch >= 26));
const { Inkbox } = await import(entry);
const client = new Inkbox({ apiKey: "synthetic-local-contract" });
if (
  !supportedVersion ||
  typeof client.whatsapp?.send !== "function" ||
  typeof client.whatsapp?.uploadMedia !== "function" ||
  typeof client.whatsapp?.getLimits !== "function" ||
  typeof client.whatsapp?.getThread !== "function" ||
  typeof client.whatsapp?.sendReaction !== "function" ||
  typeof client.whatsapp?.removeReaction !== "function" ||
  typeof client.messageSends?.lookup !== "function"
)
  throw new Error(
    "The installed plugin did not resolve the published WhatsApp SDK.",
  );
console.log(
  `Verified SDK ${manifest.version} from installed consumer: ${entry}`,
);
