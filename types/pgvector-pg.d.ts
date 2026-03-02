/** Types for pgvector/pg subpath (registerTypes; package may not ship types). */
declare module "pgvector/pg" {
  import type { PoolClient } from "pg";
  const pgvector: {
    registerTypes(client: PoolClient): Promise<void>;
    toSql(vec: number[]): string;
  };
  export default pgvector;
}
