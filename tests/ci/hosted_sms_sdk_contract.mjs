// Credential-free published SDK + actual native loader snapshot contract.
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { startPreload } from "../live/hosted_sms_sdk_observer.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const state = process.env.OPENCLAW_STATE_DIR;
assert(state);
await mkdir(state, { recursive: true });
const marker = "maple cloud river", target = "+15550000002";
const output = join(state, "observer.json"), driver = join(state, "driver.json");
await writeFile(driver, JSON.stringify({ number: target }));
const loadedSdkPaths = [];
const hook = startPreload({ marker, statePath: driver, outputPath: output, hooks: options => registerHooks({ load(url, context, next) { if (url.endsWith("/agent_identity.js")) loadedSdkPaths.push(fileURLToPath(url)); return options.load(url, context, next); } }) });
assert(hook);
let sends = 0;
const server = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/v1/phone/numbers/fixture-number/texts");
  const input = JSON.parse(body); assert.equal(input.text, marker); assert.equal(input.to, target);
  sends++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: `fixture-receipt-${sends}`, phone_number_id: "fixture-number", direction: "outbound", from_number: "+15550000001", to_number: target, text: marker, media_urls: [], status: "queued", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const pluginRoots = [];
await symlink(join(root, "node_modules"), join(state, "node_modules"), "dir");
for (const id of ["sdk-observer-one", "sdk-observer-two"]) {
  const dir = join(state, id); await mkdir(join(dir, "node_modules", "@inkbox"), { recursive: true });
  await cp(join(root, "node_modules", "@inkbox", "sdk"), join(dir, "node_modules", "@inkbox", "sdk"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: id, version: "1.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }));
  await writeFile(join(dir, "openclaw.plugin.json"), JSON.stringify({ id, name: id, contracts: { tools: [id.replaceAll("-", "_")] }, configSchema: { type: "object", additionalProperties: false, properties: {} } }));
  await writeFile(join(dir, "index.mjs"), `import {AgentIdentity} from '@inkbox/sdk'; import {HttpTransport} from './node_modules/@inkbox/sdk/dist/_http.js'; import {TextsResource} from './node_modules/@inkbox/sdk/dist/phone/resources/texts.js';\nexport default {id:${JSON.stringify(id)},name:'Fixture',register(api){api.registerTool({name:${JSON.stringify(id.replaceAll("-", "_"))},label:'Fixture',description:'Fixture',parameters:{type:'object',properties:{}},execute:async()=>{const identity=new AgentIdentity({id:'fixture-identity',phoneNumber:{id:'fixture-number'}},{_texts:new TextsResource(new HttpTransport('synthetic-only',${JSON.stringify(baseUrl + '/api/v1/phone')},3000))}); const result=await identity.sendText({to:${JSON.stringify(target)},text:${JSON.stringify(marker)}}); return {content:[{type:'text',text:'Accepted'}],details:{accepted:!!result.id}};}});}};\n`);
  pluginRoots.push(dir);
}
const cfg = { agents: { defaults: { workspace: state } }, plugins: { allow: ["sdk-observer-one", "sdk-observer-two"], load: { paths: pluginRoots }, slots: { memory: "none" }, entries: { "sdk-observer-one": { enabled: true }, "sdk-observer-two": { enabled: true } } } };
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve("openclaw/plugin-sdk/routing")));
const candidates = (await readdir(hostDist)).filter(file => /^loader-.*\.(?:m?js)$/.test(file));
let load;
for (const name of ["loadPluginRegistryHandle", "loadOpenClawPlugins"]) {
  for (const file of candidates) {
    const source = await readFile(join(hostDist, file), "utf8");
    if (!source.includes(`function ${name}(`)) continue;
    const mod = await import(pathToFileURL(join(hostDist, file)));
    load = Object.values(mod).find(fn => typeof fn === "function" && fn.name === name);
    if (load) break;
  }
  if (load) break;
}
assert.equal(typeof load, "function", "Actual native loader entrypoint missing");
const registry = load({ config: cfg, workspaceDir: state, cache: false, activate: false, logger: { info(){}, warn(){}, error(){}, debug(){} } });
assert.equal(registry.tools.length, 2, "Native plugin registration failed");
for (const entry of registry.tools) {
  const produced = entry.factory({ config: cfg, workspaceDir: state, agentId: "main", sessionKey: "agent:main:fixture" });
  const tools = Array.isArray(produced) ? produced : [produced];
  assert.equal(tools.length, 1);
  assert.equal((await tools[0].execute("fixture-tool", {})).details.accepted, true);
}
const records = JSON.parse(await readFile(output, "utf8"));
assert.equal(sends, 2);
assert.equal(new Set(loadedSdkPaths).size, 2);
const hostVersion = JSON.parse(await readFile(join(hostDist, "..", "package.json"), "utf8")).version;
if (hostVersion !== "2026.5.27") assert(loadedSdkPaths.every(path => !pluginRoots.some(root => path.startsWith(root + "/"))), "Current host must execute relocated native snapshots");
console.log(JSON.stringify({ nativeModuleCopies: new Set(loadedSdkPaths).size, relocatedNativeModules: loadedSdkPaths.every(path => !pluginRoots.some(root => path.startsWith(root + "/"))) }));
assert.equal(records.filter(row => row.module_bound === true).length, 2, "Must observe both actual native-loaded SDK copies");
assert.equal(records.filter(row => row.status === "accepted" && row.marker_matches && row.target_matches).length, 2);
assert.equal(records.filter(row => row.status === "accepted").at(-1).unique_accepted, 2);
assert(!JSON.stringify(records).includes(marker));
assert(!JSON.stringify(records).includes("fixture-receipt"));
assert(!JSON.stringify(records).includes(target));
hook.deregister(); server.close();
console.log("Published SDK 0.7.14: two actual native-loaded module graphs observed; safe accepted evidence verified.");
process.exit(0);
