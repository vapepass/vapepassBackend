import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import Customer from '../src/models/Customer.js';
import Store from '../src/models/Store.js';
import VerificationCode from '../src/models/VerificationCode.js';
import { SUBSCRIPTION_STATUS } from '../src/utils/constants.js';
import { connectTestDB, disconnectTestDB, clearCollections } from './helpers/setup.js';
import { registerPayload } from './helpers/registerPayload.js';

async function registerOwner(email, storeName) {
  const res = await request(app).post('/api/v1/auth/register').send(
    registerPayload({
      email,
      storeName,
      websiteUrl: `https://${storeName.toLowerCase().replace(/\s+/g, '-')}.example.com`,
    })
  );

  await Store.findByIdAndUpdate(res.body.data.store._id, {
    subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
  });

  return res.body.data;
}

describe('Tenant isolation', () => {
  before(async () => {
    await connectTestDB();
  });

  after(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearCollections();
  });

  test('store B cannot access store A customer', async () => {
    const storeA = await registerOwner('owner-a@store.com', 'Store A');
    const storeB = await registerOwner('owner-b@store.com', 'Store B');

    const verification = await VerificationCode.create({
      code: '123456',
      storeId: storeA.store._id,
      createdBy: storeA.user._id,
      expiresAt: new Date(Date.now() + 3600000),
    });

    const customer = await Customer.create({
      storeId: storeA.store._id,
      fullName: 'Alex Johnson',
      phone: '555-0001',
      stampGoal: 10,
      passIdentifier: 'pass-a-001',
      verificationCodeId: verification._id,
    });

    await request(app)
      .get(`/api/v1/customers/${customer._id}`)
      .set('Authorization', `Bearer ${storeB.accessToken}`)
      .expect(404);
  });

  test('store owner can invite employee to same store', async () => {
    const owner = await registerOwner('owner@store.com', 'Cloud Nine');

    const invite = await request(app)
      .post('/api/v1/store/employees')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        firstName: 'Sam',
        lastName: 'Staff',
        email: 'sam@store.com',
        password: 'StaffPass1',
      })
      .expect(201);

    assert.equal(invite.body.data.employee.role, 'employee');
    assert.equal(invite.body.data.employee.email, 'sam@store.com');

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'sam@store.com', password: 'StaffPass1' })
      .expect(200);

    assert.equal(login.body.data.user.role, 'employee');
  });
});
