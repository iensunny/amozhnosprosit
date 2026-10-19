import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const projectDir = "/var/www/www-root/data/www/79-174-82-103.regru.cloud";
const triggerFile = path.join(projectDir, ".deploy-trigger");
const stateFile = "/var/www/www-root/data/.amozhnosprosit-deploy-state";
const lockFile = "/var/www/www-root/data/.amozhnosprosit-deploy-lock";
const nodeBin = "/usr/lib/ispnodejs/bin/node";
const npmBin = "/usr/lib/ispnodejs/bin/npm";
const pm2Bin = "/usr/lib/ispnodejs/lib/node_modules/pm2/bin/pm2";
const appPort = 10000;

if (!existsSync(triggerFile)) process.exit(0);

const sha = readFileSync(triggerFile, "utf8").trim();
if (!/^[a-f0-9]{40}$/.test(sha)) {
  console.error("[deploy] Invalid deployment marker");
  process.exit(1);
}
const markerAgeMs = Date.now() - (await import("node:fs")).statSync(triggerFile).mtimeMs;
if (markerAgeMs < 15_000) process.exit(0);
if (existsSync(stateFile) && readFileSync(stateFile, "utf8").trim() === sha) {
  unlinkSync(triggerFile);
  process.exit(0);
}

let lockFd;
try {
  lockFd = await import("node:fs").then(({ openSync }) => openSync(lockFile, "wx"));
} catch {
  process.exit(0);
}

const log = (message) => console.log(`[deploy ${new Date().toISOString()}] ${message}`);
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `/usr/lib/ispnodejs/bin:${process.env.PATH ?? ""}`,
      PM2_HOME: "/var/www/www-root/data/.pm2",
    },
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status}`);
};

try {
  log(`Installing production dependencies for ${sha}`);
  run(npmBin, ["ci", "--omit=dev"]);
  log("Restarting the application");
  run(nodeBin, [pm2Bin, "restart", "0"]);

  let healthy = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:${appPort}/api/health", { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true) {
          healthy = true;
          break;
        }
      }
    } catch {
      // The app may still be coming back after PM2 restarts it.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!healthy) throw new Error("Health check did not pass after restart");

  writeFileSync(stateFile, `${sha}\n`, { mode: 0o600 });
  unlinkSync(triggerFile);
  log(`Deployment ${sha} is healthy`);
} catch (error) {
  log(`Deployment failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  const { closeSync } = await import("node:fs");
  closeSync(lockFd);
  try {
    unlinkSync(lockFile);
  } catch {
    // A missing lock means another run has already cleaned up.
  }
}
