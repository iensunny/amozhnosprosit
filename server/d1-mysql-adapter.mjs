/* Adapts the recovered Worker's small Cloudflare D1 interface to MySQL. */

function mysqlSql(input) {
  let sql = input.replace(/^\s*INSERT OR IGNORE INTO/i, "INSERT IGNORE INTO");
  const upsert = sql.match(/^\s*UPSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*;?\s*$/i);
  if (upsert) {
    const [, table, rawColumns, values] = upsert;
    const columns = rawColumns.split(",").map(column => column.trim());
    const keys = new Set({ private_notes: ["pair_id", "member_id", "day"] }[table] || []);
    if (!keys.size) throw new Error(`UPSERT is not configured for ${table}`);
    const updates = columns.filter(column => !keys.has(column));
    if (!updates.length) throw new Error(`UPSERT for ${table} has no update columns`);
    sql = `INSERT INTO ${table} (${rawColumns}) VALUES (${values}) ON DUPLICATE KEY UPDATE ${updates.map(column => `${column} = VALUES(${column})`).join(", ")}`;
  }
  return sql;
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
    const [rows] = await this.adapter.client.execute(mysqlSql(this.sql), this.values);
    return rows[0] ?? null;
  }

  async all() {
    const [rows] = await this.adapter.client.execute(mysqlSql(this.sql), this.values);
    return { results: rows };
  }

  async run(client = this.adapter.client) {
    const [result] = await client.execute(mysqlSql(this.sql), this.values);
    return { meta: { changes: result.affectedRows ?? 0 } };
  }
}

export class D1MysqlAdapter {
  constructor(client) {
    this.client = client;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    const connection = await this.client.getConnection();
    const results = [];
    try {
      await connection.beginTransaction();
      for (const statement of statements) results.push(await statement.run(connection));
      await connection.commit();
      return results;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
