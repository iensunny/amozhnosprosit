import { createReadStream, existsSync } from "node:fs";
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
const env = {
  ASSETS: { fetch: staticFetch },
  DB: new D1MysqlAdapter(pool),
  MAX_BOT_NAME: process.env.MAX_BOT_NAME || "se14681938_bot",
  MAX_BOT_TOKEN: process.env.MAX_BOT_TOKEN
};

const server = createServer(async (request, response) => {
  try {
    await sendNodeResponse(await worker.fetch(requestFromNode(request), env), response);
  } catch (error) {
    console.error("Request failed", error);
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Request failed" }));
  }
});

cron.schedule("0 * * * *", () => {
  worker.scheduled({}, env, { waitUntil: promise => promise.catch(error => console.error("Scheduled task failed", error)) });
});

async function purgeExpiredDiagnostics() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await pool.execute("DELETE FROM diagnostic_events WHERE created_at < ?", [cutoff]);
  } catch (error) {
    console.error("Diagnostic retention cleanup failed", error.message);
  }
}

void purgeExpiredDiagnostics();
cron.schedule("* * * * *", () => void purgeExpiredDiagnostics());

server.listen(Number(process.env.PORT || 8080), "0.0.0.0", () => {
  console.log(`Listening on port ${process.env.PORT || 8080}`);
});

async function shutdown() {
  await pool.end();
  server.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
