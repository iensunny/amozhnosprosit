import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "./cloudflare-worker-2026-10-15.mjs";

const env = { MAX_BOT_TOKEN: "test-token", MAX_BOT_NAME: "test_bot" };

function mockDb(pair = null) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push({ sql, operation: "prepare" });
      return {
        bind(...values) {
          calls.push({ sql, values, operation: "bind" });
          return {
            async first() {
              calls.push({ sql, operation: "first" });
              if (sql.startsWith("SELECT * FROM pairs")) return pair;
              if (sql.startsWith("SELECT role FROM members")) return { role: "adult" };
              return null;
            },
            async all() { return { results: [] }; },
            async run() { calls.push({ sql, operation: "run" }); return { success: true }; }
          };
        }
      };
    },
    async batch(statements) {
      calls.push({ operation: "batch", statements });
      return [];
    }
  };
}

async function callApi(path, body, db) {
  return worker.fetch(new Request(`https://app.example${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  }), { ...env, DB: db });
}

test("public config exposes the MAX bot name used by invitation links", async () => {
  const response = await callApi("/api/config", null, mockDb());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { maxBotName: "test_bot" });
});

test("telemetry accepts only bounded categories and stores no caller identity or free text", async () => {
  const saved = [];
  const db = {
    prepare(sql) { return { bind(...values) { return { sql, values }; } }; },
    async batch(statements) { saved.push(...statements); return []; }
  };
  const response = await callApi("/api/telemetry", {
    appVersion: "20261026-1", platform: "max",
    events: [{ eventName: "api", stage: "accept", result: "error", durationMs: 850, httpStatus: 403,
      maxUserId: "987654321", invitationToken: "never-store-this", message: "free text must not be stored" }]
  }, db);
  assert.equal(response.status, 204);
  assert.equal(saved.length, 1);
  assert.match(saved[0].sql, /INSERT INTO telemetry_events/);
  assert.deepEqual(saved[0].values.slice(2), ["api", "accept", "error", 850, 403, "20261026-1", "max"]);
  assert.equal(saved[0].values.some((value) => String(value).includes("never-store-this")), false);
});

test("telemetry rejects arbitrary event fields and does not write invalid events", async () => {
  const db = mockDb();
  const invalidEvents = [
    { eventName: "api", stage: "unknown-user-route" },
    { eventName: "api", stage: "send_daily" },
    { eventName: "notification", stage: "unknown-notification-stage" }
  ];
  for (const { eventName, stage } of invalidEvents) {
    const response = await callApi("/api/telemetry", {
      events: [{ eventName, stage, result: "ok", durationMs: 1, httpStatus: 200 }]
    }, db);
    assert.equal(response.status, 400);
  }
  assert.equal(db.calls.some(({ operation }) => operation === "batch"), false);
});

test("MAX bot_started sends a single formatted welcome per MAX user", async () => {
  const records = new Map();
  const sent = [];
  const db = {
    prepare(sql) {
      return { bind(...values) {
        return {
          async run() {
            const [firstValue, secondValue] = values;
            if (sql.startsWith("INSERT OR IGNORE INTO bot_welcomes")) {
              if (records.has(firstValue)) return { meta: { changes: 0 } };
              records.set(firstValue, { status: "processing", updated_at: secondValue });
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("UPDATE bot_welcomes")) {
              const status = /SET status = '([^']+)'/.exec(sql)?.[1];
              const record = records.get(secondValue);
              if (record && status) { record.status = status; record.updated_at = firstValue; }
              return { meta: { changes: record ? 1 : 0 } };
            }
            return { meta: { changes: 0 } };
          },
          async first() { return records.get(values[0]) || null; }
        };
      } };
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200 }; };
  try {
    const makeRequest = () => new Request("https://app.example/api/max/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Max-Bot-Api-Secret": "test-webhook-secret" },
      body: JSON.stringify({ update_type: "bot_started", user: { user_id: 123456789 } })
    });
    const first = await worker.fetch(makeRequest(), { ...env, DB: db, MAX_WEBHOOK_SECRET: "test-webhook-secret", BOT_WELCOME_ENABLED: true });
    const second = await worker.fetch(makeRequest(), { ...env, DB: db, MAX_WEBHOOK_SECRET: "test-webhook-secret", BOT_WELCOME_ENABLED: true });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.format, "markdown");
    assert.match(sent[0].body.text, /Добро пожаловать/);
    assert.equal(sent[0].body.attachments[0].payload.buttons[0][0].text, "Открыть приложение");
    assert.equal(records.get("123456789").status, "sent");
  } finally { globalThis.fetch = originalFetch; }
});

test("MAX webhook rejects requests with an invalid secret before reading user data", async () => {
  const db = mockDb();
  const response = await worker.fetch(new Request("https://app.example/api/max/webhook", {
    method: "POST", headers: { "X-Max-Bot-Api-Secret": "wrong", "Content-Type": "application/json" },
    body: JSON.stringify({ update_type: "bot_started", user: { user_id: 123456789 } })
  }), { ...env, DB: db, MAX_WEBHOOK_SECRET: "expected-secret" });
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});

test("creating a pair without signed MAX identity is rejected before database access", async () => {
  const db = mockDb();
  const response = await callApi("/api/pairs", {
    id: "pair-test-123",
    member: { id: "member-test-1", name: "Тест", role: "adult" }
  }, db);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /только в MAX/i);
  assert.equal(db.calls.length, 0);
});

test("accepting an invitation without signed MAX identity does not change membership", async () => {
  const token = "a-valid-test-invitation-token";
  const pair = {
    id: "pair-test-123", status: "pending",
    invite_hash: createHash("sha256").update(token).digest("hex"),
    invite_expires_at: new Date(Date.now() + 60_000).toISOString()
  };
  const db = mockDb(pair);
  const response = await callApi(`/api/pairs/${pair.id}/accept`, {
    invitationToken: token,
    member: { id: "member-test-2", name: "Тест 2", role: "child" }
  }, db);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /только в MAX/i);
  assert.equal(db.calls.some(({ operation }) => operation === "batch" || operation === "run"), false);
});

test("a valid invitation returns the opposite role of the inviter", async () => {
  const token = "a-valid-test-invitation-token";
  const pair = {
    id: "pair-test-123", status: "pending",
    invite_hash: createHash("sha256").update(token).digest("hex"),
    invite_expires_at: new Date(Date.now() + 60_000).toISOString()
  };
  const response = await callApi(`/api/pairs/${pair.id}/invite-role`, { invitationToken: token }, mockDb(pair));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { role: "child" });
});

test("an invalid invitation cannot reveal the role", async () => {
  const pair = {
    id: "pair-test-123", status: "pending",
    invite_hash: createHash("sha256").update("real-token").digest("hex"),
    invite_expires_at: new Date(Date.now() + 60_000).toISOString()
  };
  const response = await callApi(`/api/pairs/${pair.id}/invite-role`, { invitationToken: "wrong-token" }, mockDb(pair));
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /недействительно/i);
});

test("invalid member details return a clear error instead of blaming the invitation", async () => {
  const token = "a-valid-test-invitation-token";
  const pair = {
    id: "pair-test-123", status: "pending",
    invite_hash: createHash("sha256").update(token).digest("hex"),
    invite_expires_at: new Date(Date.now() + 60_000).toISOString()
  };
  const response = await callApi(`/api/pairs/${pair.id}/accept`, {
    invitationToken: token,
    member: { id: "member-test-2", name: "Тест 2", role: "" }
  }, mockDb(pair));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /имя и роль/i);
});

test("deleting your data deletes the whole pair so neither MAX account stays attached", async () => {
  const token = "member-token-for-delete-test-123456";
  const pair = { id: "pair-test-123", status: "active" };
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.startsWith("SELECT * FROM pairs")) return pair;
              if (sql.startsWith("SELECT id, name, role, position, max_user_id FROM members")) {
                return { id: "member-test-1", name: "Участник", role: "adult", position: 0, max_user_id: null };
              }
              return null;
            },
            async run() { calls.push({ sql, values }); return { meta: { changes: 1 } }; }
          };
        }
      };
    }
  };
  const response = await worker.fetch(new Request(`https://app.example/api/pairs/${pair.id}/members/member-test-1`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  }), { ...env, DB: db });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(calls, [{ sql: "DELETE FROM pairs WHERE id = ?", values: [pair.id] }]);
});
