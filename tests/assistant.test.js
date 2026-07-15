import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import Store from '../src/models/Store.js';
import StoreInventory from '../src/models/StoreInventory.js';
import { connectTestDB, disconnectTestDB, clearCollections } from './helpers/setup.js';
import { getLockMessage } from '../src/utils/legalAge.js';
import { registerPayload } from './helpers/registerPayload.js';
import { SUBSCRIPTION_STATUS } from '../src/utils/constants.js';

describe('Assistant API', () => {
  let accessToken;
  let storeId;
  let lockMessage;

  before(async () => {
    await connectTestDB();
  });

  after(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearCollections();

    const res = await request(app).post('/api/v1/auth/register').send(
      registerPayload({
        firstName: 'Alex',
        lastName: 'Owner',
        ownerName: 'Alex Owner',
        email: 'alex@store.com',
        storeName: 'Vapor Lounge',
        websiteUrl: 'https://example.com',
      })
    );

    accessToken = res.body.data.accessToken;
    storeId = res.body.data.store._id;
    lockMessage = getLockMessage(19, 'CA', 'BC');

    await StoreInventory.create({
      storeId,
      name: 'Mango Ice 10mg',
      brand: 'Cloud',
      flavor: 'Mango Ice',
      nicotineMgMl: 10,
      volumeMl: 30,
      productType: 'e_liquid',
      externalId: 'mango-ice',
      isActive: true,
      status: 'active',
    });

    await Store.findByIdAndUpdate(storeId, {
      productPageUrl: 'https://example.com/products',
      websiteUrl: 'https://example.com',
      allowedHostname: 'example.com',
      assistantEnabled: true,
      setupCompletedAt: new Date(),
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
      inventorySyncStatus: 'success',
      inventoryProductCount: 1,
      country: 'CA',
      province: 'BC',
    });
  });

  test('returns widget config', async () => {
    const res = await request(app)
      .get(`/api/v1/assistant/widget/${storeId}`)
      .expect(200);

    assert.equal(res.body.success, true);
    assert.equal(res.body.data.config.storeName, 'Vapor Lounge');
    assert.equal(res.body.data.config.enabled, true);
    assert.match(res.body.data.config.healthWarning, /WARNING: Vaping products contain nicotine/);
  });

  test('starts session with age question', async () => {
    const res = await request(app)
      .post('/api/v1/assistant/session')
      .send({ storeId })
      .expect(200);

    assert.equal(res.body.data.session.ageVerified, false);
    assert.equal(res.body.data.session.locked, false);
    assert.match(res.body.data.session.messages[0].content, /19 years of age or older/);
  });

  test('locks conversation on underage tripwire', async () => {
    const start = await request(app)
      .post('/api/v1/assistant/session')
      .send({ storeId });

    const sessionKey = start.body.data.session.sessionKey;

    const res = await request(app)
      .post('/api/v1/assistant/chat')
      .send({ storeId, sessionKey, message: 'I am 17' })
      .expect(200);

    assert.equal(res.body.data.session.locked, true);
    assert.equal(res.body.data.session.reply, lockMessage);

    const again = await request(app)
      .post('/api/v1/assistant/chat')
      .send({ storeId, sessionKey, message: 'just kidding I am 25' })
      .expect(200);

    assert.equal(again.body.data.session.locked, true);
    assert.equal(again.body.data.session.reply, lockMessage);
  });

  test('verifies age then allows conversation', async () => {
    const start = await request(app)
      .post('/api/v1/assistant/session')
      .send({ storeId });

    const sessionKey = start.body.data.session.sessionKey;

    const age = await request(app)
      .post('/api/v1/assistant/chat')
      .send({ storeId, sessionKey, message: 'yes' })
      .expect(200);

    assert.equal(age.body.data.session.ageVerified, true);
    assert.equal(age.body.data.session.locked, false);

    const chat = await request(app)
      .post('/api/v1/assistant/chat')
      .send({ storeId, sessionKey, message: 'I like fruity flavors' })
      .expect(200);

    assert.equal(chat.body.data.session.locked, false);
    assert.ok(chat.body.data.session.reply.length > 0);
  });

  test('store owner can get assistant status and embed code', async () => {
    const res = await request(app)
      .get('/api/v1/assistant/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    assert.equal(res.body.data.status.storeName, 'Vapor Lounge');
    assert.match(res.body.data.status.embedCode, /data-store-id=/);
    assert.match(res.body.data.status.embedCode, /widget\.js/);
  });

  test('serves embeddable widget script with site age gate', async () => {
    const res = await request(app).get('/widget.js').expect(200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.text, /Shadow DOM|attachShadow/);
    assert.match(res.text, /WARNING: Vaping products contain nicotine|healthWarning/);
    assert.match(res.text, /waitForSiteAgeGate|vapepass_site_age_verified/);
  });

  test('locks conversation on under 21 implication', async () => {
    const start = await request(app)
      .post('/api/v1/assistant/session')
      .send({ storeId });

    const sessionKey = start.body.data.session.sessionKey;

    const res = await request(app)
      .post('/api/v1/assistant/chat')
      .send({ storeId, sessionKey, message: "I'm under 21" })
      .expect(200);

    assert.equal(res.body.data.session.locked, true);
    assert.equal(res.body.data.session.reply, lockMessage);
  });

  test('uses province-specific legal age from store (Alberta = 18)', async () => {
    await Store.findByIdAndUpdate(storeId, { country: 'CA', province: 'AB' });

    const start = await request(app)
      .post('/api/v1/assistant/session')
      .send({ storeId })
      .expect(200);

    assert.match(start.body.data.session.messages[0].content, /18 years of age or older/);
    assert.equal(start.body.data.session.legalAge, 18);

    const widget = await request(app)
      .get(`/api/v1/assistant/widget/${storeId}`)
      .expect(200);

    assert.equal(widget.body.data.config.legalAge, 18);
    assert.match(widget.body.data.config.ageQuestion, /18 years of age or older/);
  });

  test('toggles Push to Customers This Month', async () => {
    const list = await request(app)
      .get('/api/v1/assistant/inventory')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const productId = list.body.data.products[0]._id;

    const res = await request(app)
      .patch(`/api/v1/assistant/inventory/${productId}/priority`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ isPriorityPromotion: true })
      .expect(200);

    assert.equal(res.body.data.product.isPriorityPromotion, true);

    const stored = await StoreInventory.findById(productId);
    assert.equal(stored.isPriorityPromotion, true);
  });

  test('recommendations only use store inventory names', async () => {
    const start = await request(app)
      .post('/api/v1/assistant/session')
      .send({ storeId });
    const sessionKey = start.body.data.session.sessionKey;

    await request(app)
      .post('/api/v1/assistant/chat')
      .send({ storeId, sessionKey, message: 'yes' });

    const chat = await request(app)
      .post('/api/v1/assistant/chat')
      .send({ storeId, sessionKey, message: 'What do you recommend?' })
      .expect(200);

    const reply = chat.body.data.session.reply.toLowerCase();
    assert.match(reply, /mango ice/i);
    assert.doesNotMatch(reply, /juul|vuse|elf bar|hallucin/i);
  });
});
