import { createReadStream, existsSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import cron from "node-cron";
import mysql from "mysql2/promise";
import worker from "../recovery/cloudflare-worker-2026-10-15.mjs";
import { D1MysqlAdapter } from "./d1-mysql-adapter.mjs";

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

const statusPasswordHash = process.env.STATUS_DASHBOARD_PASSWORD_SHA256 || "7eba24edbe0db6d9b02444dfee688662434e57922426e51840ed7194ed066e0a";
const webhookSecret = createHmac("sha256", process.env.MAX_BOT_TOKEN).update("amozhnosprosit:max-webhook:v1").digest("hex");
const publicAppOrigin = (process.env.PUBLIC_APP_URL || "https://79-174-82-103.regru.cloud").replace(/\/$/, "");

function mysqlOptions() {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must use the mysql:// scheme");
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1))
    };
  }

  const required = ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"];
  for (const variable of required) {
    if (!process.env[variable]) throw new Error(`Set DATABASE_URL or all of: ${required.join(", ")}`);
  }
  return {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  };
}

const pool = mysql.createPool({
  ...mysqlOptions(),
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 5),
  queueLimit: 0,
  charset: "utf8mb4",
  timezone: "Z"
});
await pool.query("SELECT 1");
let telemetryReady = false;
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS telemetry_events (
  id CHAR(36) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  event_name VARCHAR(24) NOT NULL,
  stage VARCHAR(32) NOT NULL,
  result VARCHAR(16) NOT NULL,
  duration_ms INT UNSIGNED NULL,
  http_status SMALLINT UNSIGNED NULL,
  app_version VARCHAR(24) NULL,
  platform VARCHAR(16) NULL,
  PRIMARY KEY (id),
  KEY telemetry_created_at (created_at),
  KEY telemetry_summary (event_name, stage, result, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  telemetryReady = true;
} catch (error) {
  // Observability is additive; a restricted DB account must not prevent the app from starting.
  console.error("Telemetry table is unavailable; app will start without telemetry", error?.code || error?.name || "Error");
}
let welcomeTableReady = false;
let maxWelcomeWebhookConfigured = false;
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS bot_welcomes (
  max_user_id VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (max_user_id),
  KEY bot_welcomes_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  welcomeTableReady = true;
} catch (error) {
  console.error("MAX welcome table is unavailable", error?.code || error?.name || "Error");
}
const env = {
  ASSETS: { fetch: staticFetch },
  DB: new D1MysqlAdapter(pool),
  MAX_BOT_NAME: process.env.MAX_BOT_NAME || "se14681938_bot",
  MAX_BOT_TOKEN: process.env.MAX_BOT_TOKEN,
  MAX_WEBHOOK_SECRET: webhookSecret,
  BOT_WELCOME_ENABLED: welcomeTableReady,
  TELEMETRY_ENABLED: telemetryReady
};

function authorizedForMonitoring(request) {
  const authorization = request.headers.authorization || "";
  const match = /^Basic\s+([A-Za-z0-9+/]+=*)$/i.exec(authorization);
  if (!match) return false;
  let decoded;
  try { decoded = Buffer.from(match[1], "base64").toString("utf8"); }
  catch { return false; }
  const divider = decoded.indexOf(":");
  if (divider < 0 || decoded.slice(0, divider) !== "owner") return false;
  const suppliedHash = createHash("sha256").update(decoded.slice(divider + 1)).digest();
  const expectedHash = Buffer.from(statusPasswordHash, "hex");
  return suppliedHash.length === expectedHash.length && timingSafeEqual(suppliedHash, expectedHash);
}

function requireMonitoringAuth(response) {
  response.writeHead(401, {
    // HTTP header values must be ASCII/Latin-1; Cyrillic here makes Node throw
    // ERR_INVALID_CHAR and turns the expected 401 challenge into a 500.
    "WWW-Authenticate": 'Basic realm="Service monitoring", charset="UTF-8"',
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end("Требуется пароль для просмотра мониторинга.");
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
  if (pathname !== "/admin/monitoring" && pathname !== "/api/admin/monitoring") return false;
  if (request.method !== "GET") {
    response.writeHead(405, { "Allow": "GET", "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  if (!authorizedForMonitoring(request)) {
    requireMonitoringAuth(response);
    return true;
  }
  if (pathname === "/admin/monitoring") {
    const page = await staticFetch(new Request(`http://localhost/monitoring.html`));
    await sendNodeResponse(page, response);
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
    if (await handleMonitoringRequest(request, response)) return;
    await sendNodeResponse(await worker.fetch(requestFromNode(request), env), response);
  } catch (error) {
    console.error("Request failed", error);
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Request failed" }));
  }
});

async function ensureMaxWelcomeSubscription() {
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
    if (!existingResponse.ok) throw new Error(`MAX subscriptions GET failed: ${existingResponse.status}`);
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
    if (!response.ok) throw new Error(`MAX subscriptions POST failed: ${response.status}`);
    const result = await response.json();
    if (result.success === false) throw new Error("MAX rejected webhook subscription");
    maxWelcomeWebhookConfigured = true;
    console.log("MAX bot_started webhook configured");
  } catch (error) {
    maxWelcomeWebhookConfigured = false;
    console.error("MAX welcome webhook setup failed", error?.message || error?.name || "Error");
  }
}

cron.schedule("0 * * * *", () => {
  worker.scheduled({}, env, { waitUntil: promise => promise.catch(error => console.error("Scheduled task failed", error)) });
});

async function purgeExpiredDiagnostics() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await pool.execute("DELETE FROM diagnostic_events WHERE created_at < ?", [cutoff]);
    if (telemetryReady) await pool.execute("DELETE FROM telemetry_events WHERE created_at < ?", [cutoff]);
  } catch (error) {
    console.error("Diagnostic and telemetry retention cleanup failed", error.message);
  }
}

void purgeExpiredDiagnostics();
cron.schedule("* * * * *", () => void purgeExpiredDiagnostics());

server.listen(Number(process.env.PORT || 8080), "0.0.0.0", () => {
  console.log(`Listening on port ${process.env.PORT || 8080}; telemetry ${telemetryReady ? "enabled" : "disabled"}`);
  void ensureMaxWelcomeSubscription();
});

async function shutdown() {
  await pool.end();
  server.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
