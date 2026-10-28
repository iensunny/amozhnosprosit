/* Adapts the recovered Worker's D1 interface to a local SQLite file. */

class Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run(database = this.database) {
    const result = database.prepare(this.sql).run(...this.values);
    return { meta: { changes: result.changes } };
  }
}

export class D1SqliteAdapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new Statement(this.database, sql);
  }

  async batch(statements) {
    const transaction = this.database.transaction(() => statements.map(statement => {
      const result = this.database.prepare(statement.sql).run(...statement.values);
      return { meta: { changes: result.changes } };
    }));
    return transaction();
  }
}
