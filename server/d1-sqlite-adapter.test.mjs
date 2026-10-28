import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { D1SqliteAdapter } from "./d1-sqlite-adapter.mjs";

function createDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(readFileSync(resolve("database/sqlite-schema.sql"), "utf8"));
  return database;
}

test("provides D1-compatible prepared statements and ignore behavior", async () => {
  const database = createDatabase();
  const db = new D1SqliteAdapter(database);
  await db.prepare("INSERT INTO pairs (id, status, created_at, time_zone) VALUES (?, ?, ?, ?)")
    .bind("pair-1", "pending", "2026-10-28T00:00:00.000Z", "Europe/Moscow").run();
  await db.prepare("INSERT OR IGNORE INTO pairs (id, status, created_at, time_zone) VALUES (?, ?, ?, ?)")
    .bind("pair-1", "pending", "2026-10-28T00:00:00.000Z", "Europe/Moscow").run();

  assert.deepEqual(await db.prepare("SELECT id FROM pairs WHERE id = ?").bind("pair-1").first(), { id: "pair-1" });
  assert.deepEqual(await db.prepare("SELECT id FROM pairs").all(), { results: [{ id: "pair-1" }] });
  database.close();
});

test("runs batches atomically and rolls back failed batches", async () => {
  const database = createDatabase();
  const db = new D1SqliteAdapter(database);
  const statements = [
    db.prepare("INSERT INTO pairs (id, status, created_at, time_zone) VALUES (?, ?, ?, ?)")
      .bind("pair-1", "pending", "now", "UTC"),
    db.prepare("INSERT INTO pairs (id, status, created_at, time_zone) VALUES (?, ?, ?, ?)")
      .bind("pair-1", "pending", "now", "UTC")
  ];

  await assert.rejects(db.batch(statements));
  assert.equal(await db.prepare("SELECT id FROM pairs").first(), null);
  database.close();
});

test("deleting a pair cascades to both members and their records", async () => {
  const database = createDatabase();
  const db = new D1SqliteAdapter(database);
  await db.prepare("INSERT INTO pairs (id, status, created_at, time_zone) VALUES (?, ?, ?, ?)")
    .bind("pair-1", "active", "now", "UTC").run();
  for (const [id, position] of [["member-1", 0], ["member-2", 1]]) {
    await db.prepare("INSERT INTO members (id, pair_id, name, role, position, token_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, "pair-1", id, position === 0 ? "adult" : "child", position, `${id}-token`).run();
  }
  await db.prepare("INSERT INTO marks (pair_id, day, at, by_member_id) VALUES (?, ?, ?, ?)")
    .bind("pair-1", 1, "now", "member-1").run();
  await db.prepare("DELETE FROM pairs WHERE id = ?").bind("pair-1").run();

  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM members").first()).count, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM marks").first()).count, 0);
  database.close();
});
