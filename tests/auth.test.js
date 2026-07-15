import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { connectTestDB, disconnectTestDB, clearCollections } from './helpers/setup.js';
import { registerPayload } from './helpers/registerPayload.js';

describe('Auth API', () => {
  before(async () => {
    await connectTestDB();
  });

  after(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearCollections();
  });

  test('registers a store owner and returns access token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(registerPayload())
      .expect(201);

    assert.equal(res.body.success, true);
    assert.ok(res.body.data.accessToken);
    assert.equal(res.body.data.user.email, 'jane@store.com');
    assert.equal(res.body.data.store.name, 'Cloud Nine Vapes');
    assert.equal(res.body.data.store.websiteUrl, 'https://cloudnine.example.com/');
  });

  test('logs in with valid credentials', async () => {
    await request(app).post('/api/v1/auth/register').send(registerPayload());

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'jane@store.com', password: 'SecurePass1' })
      .expect(200);

    assert.equal(res.body.success, true);
    assert.ok(res.body.data.accessToken);
  });

  test('refreshes access token using refresh cookie', async () => {
    const agent = request.agent(app);

    await agent.post('/api/v1/auth/register').send(registerPayload());

    const res = await agent.post('/api/v1/auth/refresh').expect(200);

    assert.equal(res.body.success, true);
    assert.ok(res.body.data.accessToken);
  });

  test('resets password with valid token', async () => {
    await request(app).post('/api/v1/auth/register').send(registerPayload());

    const forgot = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'jane@store.com' })
      .expect(200);

    assert.ok(forgot.body.data?.resetToken);

    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: forgot.body.data.resetToken, password: 'NewSecure1' })
      .expect(200);

    assert.equal(reset.body.success, true);
    assert.ok(reset.body.data.accessToken);

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'jane@store.com', password: 'NewSecure1' })
      .expect(200);
  });
});
