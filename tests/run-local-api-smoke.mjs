import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const config = path.join("dist", "server", "wrangler.json");
const persistenceRoot = path.join(root, ".wrangler");
await mkdir(persistenceRoot, { recursive: true });
const persistence = await mkdtemp(path.join(persistenceRoot, "api-smoke-"));
const commonEnv = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: path.join(persistence, "wrangler.log"),
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: commonEnv,
    encoding: "utf8",
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): node ${args.join(" ")}`);
  }
}

let worker;
try {
  run([
    wrangler,
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    persistence,
    "--config",
    config,
  ]);

  const port = await freePort();
  worker = spawn(process.execPath, [
    wrangler,
    "dev",
    "--config",
    config,
    "--port",
    String(port),
    "--persist-to",
    persistence,
    "--var",
    "INITIAL_SETUP_CODE:LOCAL-SETUP-1.6",
    "--var",
    "OWNER_RECOVERY_CODE:LOCAL-RECOVERY-1.6",
  ], {
    cwd: root,
    env: commonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerLog = "";
  worker.stdout.on("data", (chunk) => {
    const text = String(chunk);
    workerLog += text;
    process.stdout.write(text);
  });
  worker.stderr.on("data", (chunk) => {
    const text = String(chunk);
    workerLog += text;
    process.stderr.write(text);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (worker.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Worker is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Local API did not start:\n${workerLog.slice(-8_000)}`);
  const explorerUrl = workerLog.match(
    /Local Explorer API is available at (http:\/\/[^\s]+\/cdn-cgi\/explorer\/api)/,
  )?.[1];
  if (!explorerUrl) throw new Error(`Local Explorer API was not announced:\n${workerLog.slice(-8_000)}`);

  run([path.join(root, "tests", "local-api-smoke.mjs")], {
    env: {
      ...commonEnv,
      E2E_BASE_URL: baseUrl,
      E2E_EXPLORER_URL: explorerUrl,
    },
  });
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => worker.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (worker.exitCode === null) worker.kill("SIGKILL");
  }
  await rm(persistence, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 250,
  });
}
