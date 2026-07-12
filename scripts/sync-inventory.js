/**
 * Manual inventory sync for all stores.
 * Usage: node scripts/sync-inventory.js
 */
import { connectDB } from '../src/config/db.js';
import { syncAllStoreInventories } from '../src/services/inventory.service.js';

async function main() {
  await connectDB();
  const results = await syncAllStoreInventories();
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
