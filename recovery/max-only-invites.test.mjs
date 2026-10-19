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
