import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCK_MESSAGE,
  detectsUnderage,
  interpretAgeReply,
  isProductBcCompliant,
  filterRecommendableProducts,
  buildSystemPrompt,
  searchInventoryByQuery,
  buildInventoryFallbackReply,
} from '../src/utils/compliance.js';

describe('BC compliance layer', () => {
  test('detects underage tripwire phrases', () => {
    assert.equal(detectsUnderage('I am 17'), true);
    assert.equal(detectsUnderage("I'm 18"), true);
    assert.equal(detectsUnderage('high school'), true);
    assert.equal(detectsUnderage('my school'), true);
    assert.equal(detectsUnderage('no ID'), true);
    assert.equal(detectsUnderage('I do not have ID'), true);
    assert.equal(detectsUnderage('my friends at school'), true);
    assert.equal(detectsUnderage('underage'), true);
    assert.equal(detectsUnderage('minor'), true);
    assert.equal(detectsUnderage('teenager'), true);
    assert.equal(detectsUnderage('I am a student'), true);
    assert.equal(detectsUnderage("I'm under 21"), true);
    assert.equal(detectsUnderage("I'm in high school"), true);
    assert.equal(detectsUnderage('I like mango ice'), false);
  });

  test('interprets age replies', () => {
    assert.equal(interpretAgeReply('yes'), 'yes');
    assert.equal(interpretAgeReply('I am 25'), 'yes');
    assert.equal(interpretAgeReply('no'), 'no');
    assert.equal(interpretAgeReply('I am 17'), 'no');
    assert.equal(interpretAgeReply('maybe'), 'unclear');
  });

  test('enforces BC product limits', () => {
    assert.equal(isProductBcCompliant({ nicotineMgMl: 20, productType: 'e_liquid', volumeMl: 30 }), true);
    assert.equal(isProductBcCompliant({ nicotineMgMl: 21, productType: 'e_liquid', volumeMl: 30 }), false);
    assert.equal(isProductBcCompliant({ nicotineMgMl: 10, productType: 'pod', volumeMl: 2 }), true);
    assert.equal(isProductBcCompliant({ nicotineMgMl: 10, productType: 'pod', volumeMl: 3 }), false);
    assert.equal(isProductBcCompliant({ nicotineMgMl: 10, productType: 'e_liquid', volumeMl: 60 }), false);
  });

  test('filters recommendable inventory', () => {
    const products = [
      { name: 'Ok', nicotineMgMl: 10, productType: 'e_liquid', volumeMl: 30, isActive: true },
      { name: 'Too strong', nicotineMgMl: 50, productType: 'e_liquid', volumeMl: 30, isActive: true },
      { name: 'Inactive', nicotineMgMl: 10, productType: 'e_liquid', volumeMl: 30, isActive: false },
    ];
    const filtered = filterRecommendableProducts(products);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, 'Ok');
  });

  test('builds system prompt with store name, legal age, and inventory', () => {
    const prompt = buildSystemPrompt('Cloud Nine', '1. Mango Ice | Nicotine: 10mg/mL', 19);
    assert.match(prompt, /Cloud Nine/);
    assert.match(prompt, /legal purchasing age at this location is strictly 19 years old/i);
    assert.match(prompt, /Are you 19 years of age or older/);
    assert.match(prompt, /Mango Ice/);
    assert.match(prompt, /Never recommend products over 20mg\/mL nicotine/);
    assert.equal(LOCK_MESSAGE.includes('19 years of age or older'), true);
  });

  test('builds system prompt with dynamic legal age for Alberta (18)', () => {
    const prompt = buildSystemPrompt('Prairie Vapes', '1. Berry Blast', 18);
    assert.match(prompt, /strictly 18 years old/);
    assert.match(prompt, /Are you 18 years of age or older/);
  });

  test('interprets age replies relative to legal age', () => {
    assert.equal(interpretAgeReply('I am 18', 19), 'no');
    assert.equal(interpretAgeReply('I am 18', 18), 'yes');
    assert.equal(interpretAgeReply('I am 20', 21), 'no');
    assert.equal(interpretAgeReply('I am 21', 21), 'yes');
  });

  test('searches inventory by customer keywords', () => {
    const products = [
      { name: '$10 Assorted Bowls 14mm', isActive: true },
      { name: 'FLUMFI Mango Ice 5K', flavor: 'Mango Ice', isActive: true },
      { name: 'Berry Blast Pod', flavor: 'Berry', isActive: true },
      { name: 'Watermelon Frost', flavor: 'Watermelon', isActive: true },
    ];

    const mango = searchInventoryByQuery(products, 'Mango flavour vape', 3);
    assert.equal(mango.length, 1);
    assert.match(mango[0].name, /Mango/i);

    const berryIce = searchInventoryByQuery(products, 'Mango or berry with ice', 3);
    assert.ok(berryIce.some((p) => /berry|mango/i.test(p.name + (p.flavor || ''))));
    assert.ok(!berryIce.some((p) => /bowl/i.test(p.name)));
  });

  test('fallback reply uses keyword matches or honest no-match message', () => {
    const products = [
      { name: '$10 Assorted Bowls 14mm', isActive: true },
      { name: 'FLUMFI Mango Ice 5K', flavor: 'Mango Ice', isActive: true },
    ];

    const matchReply = buildInventoryFallbackReply(products, 'looking for mango');
    assert.match(matchReply, /Mango Ice/i);
    assert.doesNotMatch(matchReply, /Bowls/i);

    const noMatchReply = buildInventoryFallbackReply(products, 'chocolate dessert');
    assert.match(noMatchReply, /don't see anything matching/i);

    const genericReply = buildInventoryFallbackReply(products, 'What do you recommend?');
    assert.match(genericReply, /Mango Ice|Bowls/i);
  });
});
