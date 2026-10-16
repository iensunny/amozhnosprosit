import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import cron from "node-cron";
import postgres from "postgres";
import worker from "../recovery/cloudflare-worker-2026-10-15.mjs";
import { D1PostgresAdapter } from "./d1-postgres-adapter.mjs";

const root = resolve("public");
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png"
};

async function staticFetch(request) {
  const url = new URL(request.url);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = normalize(join(root, requested));
  if (!file.startsWith(root + "/") || !existsSync(file) || (await stat(file)).isDirectory()) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(Readable.toWeb(createReadStream(file)), {
    headers: {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=3600"
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

const required = ["DATABASE_URL", "MAX_BOT_TOKEN"];
for (const variable of required) {
  if (!process.env[variable]) throw new Error(`Missing required environment variable: ${variable}`);
}

const sql = postgres(process.env.DATABASE_URL);
const env = {
  ASSETS: { fetch: staticFetch },
  DB: new D1PostgresAdapter(sql),
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

server.listen(Number(process.env.PORT || 8080), "0.0.0.0", () => {
  console.log(`Listening on port ${process.env.PORT || 8080}`);
});
