import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLegalAge,
  getAgeQuestion,
  getLockMessage,
  getHealthWarning,
  normalizeCountry,
  normalizeProvince,
  resolveStoreLegalAge,
} from '../src/utils/legalAge.js';

describe('getLegalAge', () => {
  test('returns 21 for United States (all states)', () => {
    assert.equal(getLegalAge('US', null), 21);
    assert.equal(getLegalAge('United States', 'California'), 21);
    assert.equal(getLegalAge('USA', 'TX'), 21);
  });

  test('returns 19 for Canadian provinces in the 19+ group', () => {
    assert.equal(getLegalAge('CA', 'BC'), 19);
    assert.equal(getLegalAge('Canada', 'British Columbia'), 19);
    assert.equal(getLegalAge('CA', 'ON'), 19);
    assert.equal(getLegalAge('CA', 'Ontario'), 19);
    assert.equal(getLegalAge('CA', 'SK'), 19);
    assert.equal(getLegalAge('CA', 'NS'), 19);
    assert.equal(getLegalAge('CA', 'NB'), 19);
    assert.equal(getLegalAge('CA', 'NL'), 19);
    assert.equal(getLegalAge('CA', 'NT'), 19);
    assert.equal(getLegalAge('CA', 'NU'), 19);
    assert.equal(getLegalAge('CA', 'YT'), 19);
  });

  test('returns 18 for Alberta, Manitoba, and Quebec', () => {
    assert.equal(getLegalAge('CA', 'AB'), 18);
    assert.equal(getLegalAge('CA', 'Alberta'), 18);
    assert.equal(getLegalAge('CA', 'MB'), 18);
    assert.equal(getLegalAge('CA', 'Manitoba'), 18);
    assert.equal(getLegalAge('CA', 'QC'), 18);
    assert.equal(getLegalAge('CA', 'Quebec'), 18);
  });

  test('returns 21 for Prince Edward Island', () => {
    assert.equal(getLegalAge('CA', 'PE'), 21);
    assert.equal(getLegalAge('CA', 'Prince Edward Island'), 21);
  });

  test('defaults to 19 for Canada without province', () => {
    assert.equal(getLegalAge('CA', null), 19);
    assert.equal(getLegalAge('Canada', ''), 19);
  });

  test('builds dynamic compliance messages', () => {
    assert.equal(getAgeQuestion(19), 'Are you 19 years of age or older?');
    assert.equal(getAgeQuestion(18), 'Are you 18 years of age or older?');
    assert.equal(getAgeQuestion(21), 'Are you 21 years of age or older?');
    assert.match(getLockMessage(18, 'CA', 'AB'), /18 years of age or older/);
    assert.match(getHealthWarning(21), /21 years of age or older/);
  });

  test('resolveStoreLegalAge derives age from store location', () => {
    assert.equal(resolveStoreLegalAge({ legalAge: 19, country: 'CA', province: 'AB' }), 18);
    assert.equal(resolveStoreLegalAge({ country: 'CA', province: 'AB' }), 18);
    assert.equal(resolveStoreLegalAge({ country: 'US', province: 'CA' }), 21);
  });

  test('normalizes country and province tokens', () => {
    assert.equal(normalizeCountry(' united states '), 'US');
    assert.equal(normalizeCountry('canada'), 'CA');
    assert.equal(normalizeProvince(' British Columbia '), 'BRITISH COLUMBIA');
  });
});
