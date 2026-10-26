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
const { Inkbox } = await import(entry);
const client = new Inkbox({ apiKey: "synthetic-local-contract" });
if (
  manifest.version !== "0.7.21" ||
  typeof client.whatsapp?.send !== "function" ||
  typeof client.whatsapp?.uploadMedia !== "function" ||
  typeof client.messageSends?.lookup !== "function"
)
  throw new Error(
    "The installed plugin did not resolve the reviewed WhatsApp SDK candidate.",
  );
console.log(
  `Verified SDK ${manifest.version} from installed consumer: ${entry}`,
);
