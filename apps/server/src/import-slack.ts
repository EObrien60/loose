/**
 * One-time Slack export importer CLI.
 *   DATABASE_URL=pglite://./.loosedb pnpm --filter @loose/server import-slack ./slack-export
 * Reads the export directory, backfills history into the selected store, prints counts.
 */
import { createStore } from "./store";
import { importSlackExport } from "./slack";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: import-slack <path-to-slack-export-dir>");
  process.exit(1);
}

const store = await createStore();
const { channels, messages } = await importSlackExport(store, dir);
console.log(`imported ${messages} message(s) across ${channels} channel(s) into store=${store.kind}`);
await store.close?.();
