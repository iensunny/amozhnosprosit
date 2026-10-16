function convertSql(input) {
  let index = 0;
  let query = input.replace(/\?/g, () => `$${++index}`);
  query = query.replace(/^\s*INSERT OR IGNORE INTO/i, "INSERT INTO");
  if (/^\s*INSERT INTO/i.test(query) && !/ON CONFLICT/i.test(query)) {
    query = `${query.trimEnd()} ON CONFLICT DO NOTHING`;
  }
  return query;
}

class Statement {
  constructor(client, query, values = []) {
    this.client = client;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.client, this.query, values);
  }

  async first() {
    const rows = await this.client.unsafe(convertSql(this.query), this.values);
    return rows[0] ?? null;
  }

  async all() {
    const rows = await this.client.unsafe(convertSql(this.query), this.values);
    return { results: rows };
  }

  async run() {
    const result = await this.client.unsafe(convertSql(this.query), this.values);
    return { meta: { changes: result.count ?? 0 } };
  }
}

export class D1PostgresAdapter {
  constructor(client) {
    this.client = client;
  }

  prepare(query) {
    return new Statement(this.client, query);
  }

  async batch(statements) {
    const results = [];
    await this.client.begin(async transaction => {
      for (const statement of statements) {
        const result = await transaction.unsafe(convertSql(statement.query), statement.values);
        results.push({ meta: { changes: result.count ?? 0 } });
      }
    });
    return results;
  }
}
