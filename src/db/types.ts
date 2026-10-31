/** Minimal SQL surface the app needs. PGlite and a Postgres driver can both implement it. */
export interface SqlClient {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
}

/**
 * A database the app talks to as the non-owner role `store_ops_app`, so RLS always applies.
 * Each `transaction` call runs `fn` in one transaction and commits or rolls back.
 */
export interface Database {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/** Who is acting and in which store. Comes from the auth context, never from tool input. */
export interface Principal {
  userId: string;
  storeId: string;
}

/** The non-owner role every app transaction runs as, so RLS always applies. */
export const APP_ROLE = 'store_ops_app';
