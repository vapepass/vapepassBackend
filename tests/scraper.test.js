import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProductsFromHtml,
  detectPlatform,
  isELiquidCategoryName,
  isExcludedNonELiquidCategory,
  isLikelyELiquidProduct,
  isCatalogProduct,
} from '../src/services/scraper.service.js';

describe('Inventory scraper parser', () => {
  test('detects Shopify and WooCommerce platforms', () => {
    assert.equal(detectPlatform('cdn.shopify.com Shopify.theme', 'https://shophootz.ca'), 'shopify');
    assert.equal(
      detectPlatform('woocommerce wp-content/plugins/woocommerce', 'https://thevapefather.com'),
      'woocommerce'
    );
    assert.equal(detectPlatform('<html></html>', 'https://example.com'), 'generic');
  });

  test('parses product links and nicotine levels', () => {
    const html = `
      <html><body>
        <a href="/products/mango-ice-10mg">Mango Ice 10mg/mL 30mL E-Liquid</a>
        <a href="/products/berry-pod">Berry Blast Pod 20mg 2mL</a>
        <a href="/cart">Cart</a>
      </body></html>
    `;

    const products = parseProductsFromHtml(html, 'https://shop.example.com/products');
    assert.ok(products.length >= 2);

    const mango = products.find((p) => /mango/i.test(p.name));
    assert.ok(mango);
    assert.equal(mango.nicotineMgMl, 10);
    assert.equal(mango.volumeMl, 30);
    assert.equal(mango.productType, 'e_liquid');

    const berry = products.find((p) => /berry/i.test(p.name));
    assert.ok(berry);
    assert.equal(berry.nicotineMgMl, 20);
    assert.equal(berry.volumeMl, 2);
  });

  test('parses JSON-LD products', () => {
    const html = `
      <script type="application/ld+json">
        {"@type":"Product","name":"Watermelon Frost 12mg","brand":{"@type":"Brand","name":"VaporCo"}}
      </script>
    `;
    const products = parseProductsFromHtml(html, 'https://shop.example.com');
    assert.equal(products.length, 1);
    assert.equal(products[0].brand, 'VaporCo');
    assert.equal(products[0].nicotineMgMl, 12);
  });
});

describe('Catalog category matching (full inventory)', () => {
  test('matches flexible E-Liquids category names', () => {
    for (const name of [
      'E-Liquids',
      'E-Liquid',
      'E Juice',
      'E-Juice',
      'Vape Juice',
      'Vape Liquid',
      'e_liquids',
      'Disposable E-Liquids',
    ]) {
      assert.equal(isELiquidCategoryName(name), true, `expected match: ${name}`);
    }
  });

  test('keeps vape catalog categories (devices, disposables, accessories, pouches)', () => {
    for (const name of [
      'Devices',
      'Vape Kits',
      'Disposable Vapes',
      'Pods',
      'Tanks',
      'Coils',
      'Batteries',
      'Chargers',
      'Accessories',
      'Nicotine Pouches',
    ]) {
      assert.equal(isExcludedNonELiquidCategory(name), false, `should keep catalog: ${name}`);
      assert.equal(isCatalogProduct({ name: 'Sample', category: name }), true);
    }
  });

  test('excludes non-catalog categories (snacks, apparel, cigars)', () => {
    for (const name of [
      'Apparel',
      'CBD',
      'Cigars',
      'Cigarettes',
      'Tobacco & Cigars',
      'Non-Carbonated Beverages, Snacks',
      'Drinks & Snacks',
    ]) {
      assert.equal(isExcludedNonELiquidCategory(name), true, `expected exclude: ${name}`);
      assert.equal(isELiquidCategoryName(name), false, `should not be e-liquid: ${name}`);
    }
  });

  test('keeps Freebase / Salt Nic E-Liquid collections', () => {
    for (const name of ['Freebase E-Liquid', 'Salt Nic E-Liquid', 'E-Liquid / Juice']) {
      assert.equal(isELiquidCategoryName(name), true, `expected e-liquid: ${name}`);
      assert.equal(isExcludedNonELiquidCategory(name), false, `should not exclude: ${name}`);
    }
  });

  test('does not exclude Disposable E-Liquids as hardware', () => {
    assert.equal(isELiquidCategoryName('Disposable E-Liquids'), true);
    assert.equal(isExcludedNonELiquidCategory('Disposable E-Liquids'), false);
  });

  test('isCatalogProduct / isLikelyELiquidProduct keep full catalog membership', () => {
    assert.equal(
      isLikelyELiquidProduct({
        name: 'Mystery Flavor',
        category: 'E-Liquids',
        subcategory: 'Salt Nic',
        productType: 'other',
      }),
      true
    );
    assert.equal(
      isCatalogProduct({
        name: 'GeekVape Aegis',
        category: 'Devices',
        productType: 'device',
      }),
      true
    );
    assert.equal(
      isCatalogProduct({
        name: 'Cuban Cigar',
        category: 'Tobacco & Cigars',
        productType: 'other',
      }),
      false
    );
    assert.equal(
      isLikelyELiquidProduct({
        name: 'Mango Ice 30mL E-Liquid',
        category: 'E-Liquids',
        productType: 'e_liquid',
        volumeMl: 30,
      }),
      true
    );
  });
});
