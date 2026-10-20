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
