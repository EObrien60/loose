import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export { schema };
export * from "./schema";

/** A Drizzle handle over our schema, regardless of underlying driver. */
export type DB = PgDatabase<any, typeof schema, any>;

export interface DbHandle {
  db: DB;
  driver: "postgres" | "pglite";
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

/**
 * Build a Drizzle DB from a connection string.
 *  - `postgres://…` / `postgresql://…`  → postgres.js (Neon, prod)
 *  - `pglite://<dir>` or `memory://`     → embedded PGlite (dev / tests / single-box pilot)
 * Both expose the identical query API and run the same SQL migrations.
 */
export async function createDb(url: string): Promise<DbHandle> {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const [{ drizzle }, postgres, { migrate }] = await Promise.all([
      import("drizzle-orm/postgres-js"),
      import("postgres").then((m) => m.default),
      import("drizzle-orm/postgres-js/migrator"),
    ]);
    const client = postgres(url, { max: 10 });
    const db = drizzle(client, { schema }) as unknown as DB;
    return {
      db,
      driver: "postgres",
      migrate: () => migrate(db as never, { migrationsFolder: MIGRATIONS }),
      close: () => client.end(),
    };
  }

  const dataDir = url.startsWith("pglite://") ? url.slice("pglite://".length) : "memory://";
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema }) as unknown as DB;
  return {
    db,
    driver: "pglite",
    migrate: () => migrate(db as never, { migrationsFolder: MIGRATIONS }),
    close: () => client.close(),
  };
}
