/**
 * Verify scraper against priority client stores and persist to MongoDB.
 *
 * Usage: node scripts/verify-priority-stores.js
 */
import { connectDB } from '../src/config/db.js';
import Store from '../src/models/Store.js';
import StoreInventory from '../src/models/StoreInventory.js';
import User from '../src/models/User.js';
import { scrapeStoreProducts } from '../src/services/scraper.service.js';
import { syncStoreInventory } from '../src/services/inventory.service.js';
import { ROLES } from '../src/utils/constants.js';

const PRIORITY_STORES = [
  { name: 'The Vape Father', url: 'https://thevapefather.com' },
  { name: 'Hootz Glass & Vape', url: 'https://shophootz.ca' },
];

async function ensureOwner() {
  let user = await User.findOne({ email: 'scraper-verify@vapepass.local' });
  if (!user) {
    user = await User.create({
      firstName: 'Scraper',
      lastName: 'Verify',
      email: 'scraper-verify@vapepass.local',
      password: 'VerifyPass1!',
      role: ROLES.STORE_OWNER,
    });
  }
  return user;
}

async function ensureStore(user, name, url) {
  let store = await Store.findOne({ name, createdBy: user._id });
  if (!store) {
    store = await Store.create({
      name,
      createdBy: user._id,
      productPageUrl: url,
    });
  } else {
    store.productPageUrl = url;
    await store.save();
  }
  return store;
}

async function verifyStore(user, { name, url }) {
  console.log(`\n=== ${name} (${url}) ===`);

  // Direct scrape probe
  const scraped = await scrapeStoreProducts(url);
  console.log(`Scraped ${scraped.length} products (platform: ${scraped[0]?.platform || 'unknown'})`);
  if (scraped.length) {
    console.log('Sample:', scraped.slice(0, 5).map((p) => p.name).join(' | '));
  }

  const store = await ensureStore(user, name, url);
  const result = await syncStoreInventory(store._id);

  const count = await StoreInventory.countDocuments({ storeId: store._id, isActive: true });
  const again = await syncStoreInventory(store._id);
  const countAfterResync = await StoreInventory.countDocuments({ storeId: store._id });

  const duplicatesOk = countAfterResync === count;

  console.log(`MongoDB active products: ${count}`);
  console.log(`After second sync (total docs): ${countAfterResync} — duplicates avoided: ${duplicatesOk}`);
  console.log(`Sync status: ${result.productCount} products`);

  return {
    name,
    url,
    scraped: scraped.length,
    saved: count,
    noDuplicates: duplicatesOk,
    platform: result.platform,
    ok: scraped.length > 0 && count > 0 && duplicatesOk,
  };
}

async function main() {
  await connectDB();
  const user = await ensureOwner();

  const results = [];
  for (const store of PRIORITY_STORES) {
    try {
      results.push(await verifyStore(user, store));
    } catch (error) {
      console.error(`FAILED ${store.name}:`, error.message);
      results.push({ name: store.name, url: store.url, ok: false, error: error.message });
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));

  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
