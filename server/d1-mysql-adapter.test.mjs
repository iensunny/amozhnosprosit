import test from "node:test";
import assert from "node:assert/strict";
import { D1MysqlAdapter } from "./d1-mysql-adapter.mjs";

function mockPool({ rows = [], affectedRows = 1, failAt } = {}) {
  const calls = [];
  let sequence = 0;
  const connection = {
    async beginTransaction() { calls.push(["begin"]); },
    async execute(sql, values) {
      calls.push(["execute", sql, values]);
      if (sequence++ === failAt) throw new Error("query failed");
      return [sql.startsWith("SELECT") ? rows : { affectedRows }, []];
    },
    async commit() { calls.push(["commit"]); },
    async rollback() { calls.push(["rollback"]); },
    release() { calls.push(["release"]); }
  };
  return {
    calls,
    async execute(sql, values) { return connection.execute(sql, values); },
    async getConnection() { return connection; }
  };
}

test("adapts D1 duplicate-ignore and MySQL upsert syntax", async () => {
  const pool = mockPool({ affectedRows: 0 });
  const db = new D1MysqlAdapter(pool);

  await db.prepare("INSERT OR IGNORE INTO marks (pair_id, day, at, by_member_id) VALUES (?, ?, ?, ?)")
    .bind("pair", 3, "2026-10-19T00:00:00.000Z", "member").run();
  await db.prepare("UPSERT INTO private_notes (pair_id, member_id, day, text, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind("pair", "member", 3, "note", "now").run();

  assert.equal(pool.calls[0][1], "INSERT IGNORE INTO marks (pair_id, day, at, by_member_id) VALUES (?, ?, ?, ?)");
  assert.equal(pool.calls[1][1], "INSERT INTO private_notes (pair_id, member_id, day, text, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE text = VALUES(text), updated_at = VALUES(updated_at)");
});

test("returns D1-compatible SELECT results", async () => {
  const pool = mockPool({ rows: [{ id: "pair-1" }] });
  const db = new D1MysqlAdapter(pool);

  assert.deepEqual(await db.prepare("SELECT id FROM pairs WHERE id = ?").bind("pair-1").first(), { id: "pair-1" });
  assert.deepEqual(await db.prepare("SELECT id FROM pairs").all(), { results: [{ id: "pair-1" }] });
});

test("runs D1 batches transactionally and rolls back errors", async () => {
  const pool = mockPool();
  const db = new D1MysqlAdapter(pool);
  const statements = [
    db.prepare("INSERT INTO pairs (id) VALUES (?)").bind("pair-1"),
    db.prepare("INSERT INTO members (id) VALUES (?)").bind("member-1")
  ];

  const result = await db.batch(statements);
  assert.equal(result.length, 2);
  assert.deepEqual(pool.calls.map(call => call[0]), ["begin", "execute", "execute", "commit", "release"]);

  const failingPool = mockPool({ failAt: 1 });
  await assert.rejects(new D1MysqlAdapter(failingPool).batch(statements), /query failed/);
  assert.deepEqual(failingPool.calls.map(call => call[0]), ["begin", "execute", "execute", "rollback", "release"]);
});
