/* Keeps the recovered Worker's small Cloudflare D1 query interface intact. */

const primaryKeys = {
  daily_notifications: ["pair_id", "day", "member_id"],
  marks: ["pair_id", "day"],
  question_days: ["pair_id", "day"]
};

function tagged(client, text, values) {
  const strings = text.split("?");
  strings.raw = strings;
  return client(strings, ...values);
}

function yql(sql) {
  return sql
    .replace(/\bINSERT OR IGNORE INTO\b/i, "UPSERT INTO")
    .replace(/\bINSERT INTO\b/i, "UPSERT INTO");
}

function ignoredInsert(sql, values) {
  const match = sql.match(/^\s*INSERT OR IGNORE INTO\s+(\w+)\s*\(([^)]+)\)/i);
  if (!match) return null;
  const [, table, rawColumns] = match;
  const columns = rawColumns.split(",").map(column => column.trim());
  const keys = primaryKeys[table];
  if (!keys) throw new Error(`INSERT OR IGNORE is not configured for ${table}`);
  return {
    conditions: keys.map(key => `${key} = ?`).join(" AND "),
    keyValues: keys.map(key => values[columns.indexOf(key)]),
    table
  };
}

async function execute(client, sql, values) {
  const ignore = ignoredInsert(sql, values);
  if (ignore) {
    const [existing] = await tagged(client, `SELECT 1 AS present FROM ${ignore.table} WHERE ${ignore.conditions}`, ignore.keyValues);
    if (existing.length) return { changed: 0, rows: [] };
  }
  const rows = await tagged(client, yql(sql), values);
  return { changed: 1, rows: rows[0] ?? [] };
}

class Statement {
  constructor(adapter, sql, values = []) {
    this.adapter = adapter;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.adapter, this.sql, values);
  }

  async first() {
    const { rows } = await execute(this.adapter.client, this.sql, this.values);
    return rows[0] ?? null;
  }

  async all() {
    const { rows } = await execute(this.adapter.client, this.sql, this.values);
    return { results: rows };
  }

  async run() {
    const { changed } = await execute(this.adapter.client, this.sql, this.values);
    return { meta: { changes: changed } };
  }
}

export class D1YdbAdapter {
  constructor(client) {
    this.client = client;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    const results = [];
    await this.client.begin(async transaction => {
      for (const statement of statements) {
        const { changed } = await execute(transaction, statement.sql, statement.values);
        results.push({ meta: { changes: changed } });
      }
    });
    return results;
  }
}
