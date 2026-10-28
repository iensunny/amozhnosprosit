import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import cron from "node-cron";
import Database from "better-sqlite3";
import worker from "../recovery/cloudflare-worker-2026-10-15.mjs";
import { D1SqliteAdapter } from "./d1-sqlite-adapter.mjs";
import { createMonitoringAuth } from "./monitoring-auth.mjs";

const root = resolve("public");
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

async function staticFetch(request) {
  const url = new URL(request.url);
  let requested;
  try {
    requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const file = normalize(join(root, requested));
  if (!file.startsWith(root + "/") || !existsSync(file) || (await stat(file)).isDirectory()) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(Readable.toWeb(createReadStream(file)), {
    headers: {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      // The HTML selects the versioned JS/CSS files. It must stay fresh so
      // MAX opens the current app after a deploy; assets can remain cached.
      "Cache-Control": requested === "/index.html" ? "no-cache" : "public, max-age=3600"
    }
  });
}

function requestFromNode(request) {
  const host = request.headers.host || "localhost";
  const method = request.method || "GET";
  return new Request(`http://${host}${request.url || "/"}`, {
    method,
    headers: request.headers,
    body: method === "GET" || method === "HEAD" ? undefined : request,
    duplex: "half"
  });
}

async function sendNodeResponse(response, result) {
  result.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return result.end();
  Readable.fromWeb(response.body).pipe(result);
}

const required = ["MAX_BOT_TOKEN"];
for (const variable of required) {
  if (!process.env[variable]) throw new Error(`Missing required environment variable: ${variable}`);
}

const statusPasswordConfigured = /^[a-f0-9]{64}$/i.test(process.env.STATUS_DASHBOARD_PASSWORD_SHA256 || "");
const monitoringAuth = createMonitoringAuth(process.env.STATUS_DASHBOARD_PASSWORD_SHA256);
const webhookSecret = createHmac("sha256", process.env.MAX_BOT_TOKEN).update("amozhnosprosit:max-webhook:v1").digest("hex");
const productionAppOrigin = "https://amozhnosprosit.365ksebe.ru";
const configuredAppOrigin = (process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
const publicAppOrigin = (() => {
  try {
    return configuredAppOrigin && new URL(configuredAppOrigin).hostname === new URL(productionAppOrigin).hostname
      ? configuredAppOrigin
      : productionAppOrigin;
  } catch {
    return productionAppOrigin;
  }
})();
const maxWebhookSetupEnabled = process.env.MAX_WEBHOOK_SETUP_ENABLED !== "false";
let maxWelcomeWebhookStatus = maxWebhookSetupEnabled ? "configuring" : "disabled";
let maxWelcomeWebhookError = null;
let maxWelcomeWebhookLastEventAt = null;
let maxWelcomeWebhookLastHttpStatus = null;
const scheduledJobsEnabled = process.env.ENABLE_SCHEDULED_JOBS !== "false";

const databasePath = resolve(process.env.SQLITE_PATH || "data/amozhnosprosit.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
database.exec(readFileSync(resolve("database/sqlite-schema.sql"), "utf8"));
const pool = {
  query(sql, values = []) {
    const statement = database.prepare(sql);
    return Promise.resolve([statement.reader ? statement.all(...values) : statement.run(...values)]);
  },
  execute(sql, values = []) {
    const statement = database.prepare(sql);
    return Promise.resolve(statement.reader
      ? [statement.all(...values)]
      : [{ affectedRows: statement.run(...values).changes }]);
  },
  end() { database.close(); return Promise.resolve(); }
};
await database.prepare("SELECT 1").get();
const telemetryReady = true;
const welcomeTableReady = true;
let maxWelcomeWebhookConfigured = false;
const env = {
  ASSETS: { fetch: staticFetch },
  DB: new D1SqliteAdapter(database),
  MAX_BOT_NAME: process.env.MAX_BOT_NAME || "se14681938_bot",
  MAX_BOT_TOKEN: process.env.MAX_BOT_TOKEN,
  MAX_WEBHOOK_SECRET: webhookSecret,
  BOT_WELCOME_ENABLED: welcomeTableReady,
  TELEMETRY_ENABLED: telemetryReady
};

function requireMonitoringAuth(response) {
  response.writeHead(401, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify({ error: "Требуется вход", loginRequired: true }));
}

async function handleMonitoringLogin(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { "Allow": "POST", "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString("utf8");
    if (body.length > 2048) {
      response.writeHead(413, { "Cache-Control": "no-store" });
      response.end();
      return true;
    }
  }
  const password = new URLSearchParams(body).get("password") || "";
  const valid = monitoringAuth.verifyPassword(password);
  if (!valid) {
    response.writeHead(statusPasswordConfigured ? 401 : 503, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify({ error: statusPasswordConfigured ? "Пароль не подошёл" : "Вход не настроен" }));
    return true;
  }
  const token = monitoringAuth.createSession();
  response.writeHead(200, {
    "Set-Cookie": monitoringAuth.cookie(token),
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify({ ok: true }));
  return true;
}

async function monitoringSnapshot() {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  let database = "ok";
  try { await pool.query("SELECT 1"); } catch { database = "error"; }
  const [totals] = await pool.execute(`SELECT
    SUM(created_at >= ? AND event_name = 'startup' AND stage = 'app_boot') AS launches_24h,
    SUM(created_at >= ? AND event_name = 'startup' AND stage = 'app_boot') AS launches_7d,
    SUM(created_at >= ? AND event_name = 'startup' AND stage = 'ready' AND result IN ('error', 'timeout')) AS startup_errors_24h,
    SUM(created_at >= ? AND event_name = 'flow' AND stage = 'pair_create' AND result = 'ok') AS pairs_created_24h,
    SUM(created_at >= ? AND event_name = 'flow' AND stage = 'pair_accept' AND result = 'ok') AS pairs_joined_24h,
    SUM(created_at >= ? AND event_name = 'notification' AND result = 'accepted') AS notifications_24h,
    SUM(created_at >= ? AND event_name = 'notification' AND result = 'error') AS notification_errors_24h,
    SUM(created_at >= ? AND result IN ('error', 'timeout')) AS telemetry_errors_24h
    FROM telemetry_events WHERE created_at >= ?`, [dayAgo, weekAgo, dayAgo, dayAgo, dayAgo, dayAgo, dayAgo, dayAgo, weekAgo]);
  const [stages] = await pool.execute(`SELECT stage, result, COUNT(*) AS samples,
    ROUND(AVG(duration_ms)) AS average_ms, MAX(duration_ms) AS max_ms
    FROM telemetry_events WHERE event_name = 'startup' AND created_at >= ?
    GROUP BY stage, result ORDER BY stage, result`, [weekAgo]);
  const [diagnostics] = await pool.execute(`SELECT created_at, stage, error_type, error_code
    FROM diagnostic_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT 20`, [dayAgo]);
  const [telemetryErrors] = await pool.execute(`SELECT created_at, event_name, stage, result, http_status
    FROM telemetry_events WHERE created_at >= ? AND result IN ('error', 'timeout')
    ORDER BY created_at DESC LIMIT 20`, [dayAgo]);
  const errors = [
    ...diagnostics.map(row => ({ ...row, source: "diagnostic" })),
    ...telemetryErrors.map(row => ({ ...row, source: "telemetry" }))
  ].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 25);
  return {
    checkedAt: new Date(now).toISOString(),
    service: "ok",
    database,
    telemetry: telemetryReady ? "on" : "off",
    welcome: welcomeTableReady && maxWelcomeWebhookConfigured ? "on" : "off",
    totals: Object.fromEntries(Object.entries(totals[0] || {}).map(([key, value]) => [key, Number(value || 0)])),
    stages,
    errors
  };
}

async function handleMonitoringRequest(request, response) {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (pathname === "/api/admin/login") return handleMonitoringLogin(request, response);
  if (pathname !== "/admin/monitoring" && pathname !== "/api/admin/monitoring") return false;
  if (request.method !== "GET") {
    response.writeHead(405, { "Allow": "GET", "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  if (pathname === "/admin/monitoring") {
    const pageName = monitoringAuth.hasSession(request.headers.cookie || "") ? "monitoring.html" : "monitoring-login.html";
    const page = await staticFetch(new Request(`http://localhost/${pageName}`));
    await sendNodeResponse(page, response);
    return true;
  }
  if (!monitoringAuth.hasSession(request.headers.cookie || "")) {
    requireMonitoringAuth(response);
    return true;
  }
  try {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify(await monitoringSnapshot()));
  } catch (error) {
    console.error("Monitoring snapshot failed", error?.code || error?.name || "Error");
    response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Статистика временно недоступна" }));
  }
  return true;
}

const server = createServer(async (request, response) => {
  try {
    if (new URL(request.url || "/", "http://localhost").pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(JSON.stringify({
        ok: true,
        welcomeWebhook: maxWelcomeWebhookStatus,
        welcomeWebhookLastEventAt: maxWelcomeWebhookLastEventAt,
        welcomeWebhookLastHttpStatus: maxWelcomeWebhookLastHttpStatus,
        ...(maxWelcomeWebhookError ? { welcomeWebhookError: maxWelcomeWebhookError } : {})
      }));
      return;
    }
    if (await handleMonitoringRequest(request, response)) return;
    const workerResponse = await worker.fetch(requestFromNode(request), env);
    if (new URL(request.url || "/", "http://localhost").pathname === "/api/max/webhook") {
      maxWelcomeWebhookLastEventAt = new Date().toISOString();
      maxWelcomeWebhookLastHttpStatus = workerResponse.status;
    }
    await sendNodeResponse(workerResponse, response);
  } catch (error) {
    console.error("Request failed", error);
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Request failed" }));
  }
});

async function ensureMaxWelcomeSubscription() {
  maxWelcomeWebhookStatus = "configuring";
  maxWelcomeWebhookError = null;
  if (!welcomeTableReady) {
    console.error("MAX webhook setup skipped because welcome storage is unavailable");
    return;
  }
  const url = `${publicAppOrigin}/api/max/webhook`;
  try {
    const existingResponse = await fetch("https://platform-api2.max.ru/subscriptions", {
      headers: { Authorization: process.env.MAX_BOT_TOKEN },
      signal: AbortSignal.timeout(10000)
    });
    if (!existingResponse.ok) {
      maxWelcomeWebhookStatus = "failed";
      maxWelcomeWebhookError = `subscriptions_get_http_${existingResponse.status}`;
      throw new Error(`MAX subscriptions GET failed: ${existingResponse.status}`);
    }
    const existingPayload = await existingResponse.json();
    const subscriptions = Array.isArray(existingPayload.subscriptions) ? existingPayload.subscriptions : [];
    const existing = subscriptions.find(item => item.url === url);
    const updateTypes = [...new Set([...(Array.isArray(existing?.update_types) ? existing.update_types : []), "bot_started"] )];
    const response = await fetch("https://platform-api2.max.ru/subscriptions", {
      method: "POST",
      headers: { Authorization: process.env.MAX_BOT_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ url, update_types: updateTypes, secret: webhookSecret }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      maxWelcomeWebhookStatus = "failed";
      maxWelcomeWebhookError = `subscriptions_post_http_${response.status}`;
      throw new Error(`MAX subscriptions POST failed: ${response.status}`);
    }
    const result = await response.json();
    if (result.success === false) {
      maxWelcomeWebhookStatus = "failed";
      maxWelcomeWebhookError = "subscription_rejected";
      throw new Error("MAX rejected webhook subscription");
    }
    maxWelcomeWebhookConfigured = true;
    maxWelcomeWebhookStatus = "configured";
    console.log("MAX bot_started webhook configured");
  } catch (error) {
    maxWelcomeWebhookConfigured = false;
    maxWelcomeWebhookStatus = "failed";
    maxWelcomeWebhookError ||= error?.name === "TimeoutError" ? "max_timeout" : "subscription_network_error";
    console.error("MAX welcome webhook setup failed", maxWelcomeWebhookError);
  }
}

if (scheduledJobsEnabled) {
  cron.schedule("0 * * * *", () => {
    worker.scheduled({}, env, { waitUntil: promise => promise.catch(error => console.error("Scheduled task failed", error)) });
  });
}

async function purgeExpiredDiagnostics() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await pool.execute("DELETE FROM diagnostic_events WHERE created_at < ?", [cutoff]);
    if (telemetryReady) await pool.execute("DELETE FROM telemetry_events WHERE created_at < ?", [cutoff]);
  } catch (error) {
    console.error("Diagnostic and telemetry retention cleanup failed", error.message);
  }
}

if (scheduledJobsEnabled) {
  void purgeExpiredDiagnostics();
  cron.schedule("* * * * *", () => void purgeExpiredDiagnostics());
}

server.listen(Number(process.env.PORT || 8080), process.env.HOST || "0.0.0.0", () => {
  console.log(`Listening on port ${process.env.PORT || 8080}; telemetry ${telemetryReady ? "enabled" : "disabled"}`);
  if (maxWebhookSetupEnabled) void ensureMaxWelcomeSubscription();
  else console.log("MAX webhook setup disabled by configuration");
  if (!scheduledJobsEnabled) console.log("Scheduled jobs disabled by configuration");
});

async function shutdown() {
  await pool.end();
  server.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
