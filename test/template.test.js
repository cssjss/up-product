import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadTemplate } from '../src/template.js';

function fixture(rows, images = ['主图-01.jpg', 'SKU-01-黑色.jpg', '详情-01.jpg']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbupproduct-template-'));
  fs.mkdirSync(path.join(root, 'images'));
  for (const image of images) fs.writeFileSync(path.join(root, 'images', image), 'sample');
  fs.writeFileSync(path.join(root, 'product.txt'), [
    '## 来源链接',
    'https://detail.1688.com/offer/123.html',
    '## 商品 ID',
    '123',
    '## 标题',
    '测试手机壳',
    '## 分类',
    '手机保护套',
    '## 商品参数',
    '品牌: 壳遇',
    '## 规格',
    ...rows,
  ].join('\r\n'));
  return root;
}

test('maps exact SKU combinations, price, stock, and color images', () => {
  const root = fixture([
    '颜色: 黑色 [img:https://example.com/a.jpg], 适用型号: 苹果11/XR [skuid:101] — ¥10.50',
    '颜色: 黑色 [img:https://example.com/a.jpg], 适用型号: 苹果12 [skuid:102] — ¥11.25',
  ]);
  try {
    const result = loadTemplate(root);
    assert.deepEqual(result.issues, []);
    assert.equal(result.skuRows.length, 2);
    assert.equal(result.skuRows[0].salePrice, 20.5);
    assert.equal(result.skuRows[1].salePrice, 21.25);
    assert.equal(result.skuRows[0].stock, 1000);
    assert.equal(path.basename(result.skuRows[0].skuImage), 'SKU-01-黑色.jpg');
    assert.equal(result.brand, 'rhode');
    assert.equal(result.imageFolderName, '测试手');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects duplicate combinations and missing color images', () => {
  const row = '颜色: 红色 [img:https://example.com/a.jpg], 适用型号: 苹果11 [skuid:101] — ¥10.50';
  const root = fixture([row, row.replace('skuid:101', 'skuid:102')]);
  try {
    const result = loadTemplate(root);
    assert.ok(result.issues.some((issue) => issue.includes('重复规格组合')));
    assert.ok(result.issues.some((issue) => issue.includes('缺少 SKU 图')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('splits grouped phone models into two display layers without losing source SKU mapping', () => {
  const rows = [];
  let id = 100;
  for (const color of ['黑色', '红色']) {
    for (const model of ['苹果11/XR（手机壳+包装）', '苹果12/12PRO（手机壳+包装）']) {
      rows.push(`颜色: ${color} [img:https://example.com/${color}.jpg], 适用型号: ${model} [skuid:${id++}] — ¥10.50`);
    }
  }
  const root = fixture(rows, ['主图-01.jpg', 'SKU-01-黑色.jpg', 'SKU-02-红色.jpg']);
  try {
    const result = loadTemplate(root);
    assert.deepEqual(result.issues, []);
    assert.equal(result.skuPlan.mode, 'two-layer');
    assert.equal(result.skuPlan.rows.length, 8);
    assert.deepEqual(result.skuPlan.models, ['iPhone 11', 'iPhone XR', 'iPhone 12', 'iPhone 12 Pro']);
    assert.deepEqual(result.skuPlan.rows.slice(0, 2).map((row) => row.sourceSkuId), ['100', '100']);
    assert.equal(result.skuPlan.colors[0].base, '黑色');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
