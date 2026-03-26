declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string, options?: { create?: boolean });
    exec(sql: string): void;
    run(
      sql: string,
      params?: Array<number | string | Uint8Array | null>,
    ): { changes: number; lastInsertRowid: number | bigint };
    query(sql: string): {
      values(params?: Array<number | string | Uint8Array | null>): unknown[][];
    };
  }
}
