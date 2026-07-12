import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProductsFromHtml,
  detectPlatform,
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

