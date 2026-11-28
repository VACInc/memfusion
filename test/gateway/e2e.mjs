import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [entry, lancePlugin] = process.argv.slice(2);
if (!entry || !path.isAbsolute(entry)) throw new Error("Pass the absolute path to a built OpenClaw entry point.");
assert.ok(Object.values(networkInterfaces()).flat().every((address) => address.internal),
  "Run in an isolated network namespace with loopback enabled");

const root = await mkdtemp(path.join(tmpdir(), "memfusion-gateway-"));
const plugin = fileURLToPath(new URL("../..", import.meta.url));
const workspace = path.join(root, "workspace");
const vault = path.join(root, "wiki");
const configPath = path.join(root, "openclaw.json");
const socket = createServer().listen(0, "localhost");
await once(socket, "listening");
const { port } = socket.address();
await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
const url = `http://localhost:${port}`;
const env = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: root,
  TMPDIR: root,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
};

const wiki = "Wikiquartz";
const original = "Workspacegarnet";
const lanceText = "Lanceamethyst belongs to the fixture.";
const appended = "Workspaceagate";
const runCli = (...args) => {
  const result = spawnSync(process.execPath, [entry, ...args], {
    env, cwd: root, encoding: "utf8", timeout: 45_000,
  });
  assert.ifError(result.error);
  return result;
};

let gateway;
let embeddings;
let gatewayOutput = "";
async function invoke(tool, args) {
  const response = await fetch(`${url}/tools/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args, sessionKey: "main" }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.result.details;
}

async function stopGateway() {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
    const exited = once(gateway, "exit");
    gateway.kill("SIGTERM");
    const deadline = AbortSignal.timeout(10_000);
    await Promise.race([exited, once(deadline, "abort")]);
    if (gateway.exitCode === null && gateway.signalCode === null) {
      gateway.kill("SIGKILL");
      await exited;
    }
  }
}


try {
  await mkdir(workspace);
  await writeFile(path.join(workspace, "MEMORY.md"), `# Memory\n\n${original} belongs to the fixture.\n`);
  const backendConfig = {};
  if (lancePlugin) {
    assert.ok(path.isAbsolute(lancePlugin), "Pass an absolute LanceDB Pro plugin directory");
    const require = createRequire(path.join(lancePlugin, "package.json"));
    const { createJiti } = require("jiti");
    const { MemoryStore } = createJiti(import.meta.url)(path.join(lancePlugin, "src/store.ts"));
    const dbPath = path.join(root, "lancedb");
    const store = new MemoryStore({ dbPath, vectorDim: 4 });
    await store.store({
      text: lanceText, vector: [1, 0, 0, 0], category: "fact", scope: "global", importance: 0.7, metadata: "{}",
    });
    embeddings = createHttpServer(async (request, response) => {
      assert.equal(request.url, "/v1/embeddings");
      const body = JSON.parse(await text(request));
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) }));
    }).listen(0, "localhost");
    await once(embeddings, "listening");
    backendConfig["memory-lancedb-pro"] = {
      enabled: true,
      config: {
        dbPath,
        embedding: {
          apiKey: ["fixture", "only"].join("-"),
          model: "fixture",
          dimensions: 4,
          baseURL: `http://localhost:${embeddings.address().port}/v1`,
        },
        retrieval: { mode: "vector", rerank: "none" },
        autoCapture: false,
        autoRecall: false,
      },
    };
  }
  const config = {
    agents: { defaults: { workspace } },
    gateway: { port, mode: "local", bind: "loopback", auth: { mode: "none" }, controlUi: { enabled: false } },
    discovery: { mdns: { mode: "off" } },
    cron: { enabled: false },
    memory: { search: { provider: "none" } },
    plugins: {
      allow: ["memfusion", "memory-core", "memory-wiki", ...Object.keys(backendConfig)],
      load: { paths: lancePlugin ? [plugin, lancePlugin] : [plugin] },
      slots: { memory: "memfusion" },
      entries: {
        ...backendConfig,
        memfusion: { enabled: true, config: { store: ["workspace"] } },
        "memory-core": { enabled: true, config: { dreaming: { enabled: false } } },
        "memory-wiki": { enabled: true, config: { vault: { path: vault } } },
      },
    },
  };
  await writeFile(configPath, JSON.stringify(config));
  const init = runCli("wiki", "init");
  assert.equal(init.status, 0, init.stderr || init.stdout);
  await writeFile(path.join(vault, "sources", "quartz.md"), `---\npageType: source\nid: source.quartz\ntitle: ${wiki}\n---\n\n# ${wiki}\n\n${wiki} belongs to the fixture.\n`);
  gateway = spawn(process.execPath, [entry, "gateway", "run"], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [gateway.stdout, gateway.stderr]) {
    stream.on("data", (chunk) => { gatewayOutput = (gatewayOutput + chunk).slice(-16_384); });
  }
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
    if (response?.ok) break;
    if (attempt === 239 || gateway.exitCode !== null) throw new Error("Fixture Gateway did not become ready.");
    await setTimeout(250);
  }
  const indexed = await invoke("memory_search", { query: original });
  assert.ok(indexed.results.some((hit) => hit.store === "memory-core" && hit.excerpt.includes(original)), JSON.stringify(indexed));
  const found = await invoke("memory_search", { query: wiki });
  const page = found.results.find((hit) => hit.source === "wiki" && hit.excerpt.includes(wiki));
  assert.ok(page, JSON.stringify(found));
  const read = await invoke("memory_get", { ref: page.ref });
  assert.equal(read.status, "ok");
  assert.match(read.text, new RegExp(wiki));

  if (lancePlugin) {
    const results = await invoke("memory_search", { query: "Lanceamethyst" });
    const lance = results.results.find((hit) => hit.store === "memory-lancedb-pro");
    assert.ok(lance, JSON.stringify(results));
    assert.equal(lance.excerpt, lanceText);
    assert.equal((await invoke("memory_get", { ref: lance.ref })).text, lanceText);
    console.log("Gateway tools verified LanceDB Pro search and get through the legacy backend adapter");
  }

  const saved = await invoke("memory_store", { text: appended });
  assert.equal(saved.status, "stored", JSON.stringify(saved));
  assert.match(await readFile(path.join(workspace, saved.stored[0].ref), "utf8"), new RegExp(appended));
  const start = performance.now();
  for (;;) {
    const updated = await invoke("memory_search", { query: appended });
    if (updated.results.some((hit) => hit.store === "memory-core" && hit.excerpt.includes(appended))) break;
    assert.ok(performance.now() - start < 10_000, JSON.stringify(updated));
    await setTimeout(250);
  }
  console.log(`Gateway tools verified workspace search, Wiki search and get, and workspace watcher indexing after ${Math.round(performance.now() - start)} ms`);
  await stopGateway();
  config.plugins.entries["memory-core"].config.dreaming.enabled = true;
  await writeFile(configPath, JSON.stringify(config));
  const statusCli = runCli("memory", "status", "--json");
  assert.equal(statusCli.status, 0, statusCli.stderr || statusCli.stdout);
  const [status] = JSON.parse(statusCli.stdout);
  assert.equal(status.provider, "memfusion");
  assert.equal(status.memoryCore, "consolidation-sidecar");
  assert.ok(!Object.hasOwn(status.health.details?.backends ?? {}, "memory-core"),
    "The host now exposes the dreaming sidecar as a backend; revisit this check and the documented limitation.");
  const searchCli = runCli("memory", "search", original, "--json");
  assert.equal(searchCli.status, 1, searchCli.stderr || searchCli.stdout);
  assert.match(searchCli.stdout, /memfusion/);
  console.log("CLI verified selected-provider status, Memory Core consolidation mode, and owner-specific search refusal");
} catch (error) {
  if (gatewayOutput) console.error(gatewayOutput);
  throw error;
} finally {
  await stopGateway();
  embeddings?.close();
  await rm(root, { recursive: true });
}
