import fs from 'node:fs';
import path from 'node:path';
import { buildSkuPlan } from './sku-plan.js';
import { imageFolderName } from './image-folder.js';

const SKU_LINE = /^颜色:\s*(.*?)\s*\[img:([^\]]*)\]\s*,\s*适用型号:\s*(.*?)\s*\[skuid:(\d+)\]\s*[—–-]\s*¥?\s*([\d.]+)\s*$/;

function sectionsOf(text) {
  const sections = new Map();
  let name = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      name = heading[1].trim();
      sections.set(name, []);
    } else if (name && line) {
      sections.get(name).push(line);
    }
  }
  return sections;
}

function numberedFiles(files, prefix, extensions) {
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.(${extensions.join('|')})$`, 'i');
  return files
    .map((file) => ({ file, match: pattern.exec(path.basename(file)) }))
    .filter(({ match }) => match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map(({ file }) => file);
}

function parseAttributes(lines) {
  const attributes = {};
  for (const line of lines ?? []) {
    const colon = line.indexOf(':');
    if (colon > 0) attributes[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return attributes;
}

export function loadTemplate(folder, options = {}) {
  const root = path.resolve(folder);
  const textFile = path.join(root, 'product.txt');
  const imageDir = path.join(root, 'images');
  if (!fs.existsSync(textFile)) throw new Error(`找不到 ${textFile}`);
  if (!fs.statSync(textFile).isFile()) throw new Error('product.txt 不是文件');
  if (!fs.existsSync(imageDir) || !fs.statSync(imageDir).isDirectory()) {
    throw new Error(`找不到图片文件夹 ${imageDir}`);
  }

  const sections = sectionsOf(fs.readFileSync(textFile, 'utf8'));
  const first = (name) => sections.get(name)?.[0]?.trim() ?? '';
  const sourceUrl = first('来源链接');
  const offerId = first('商品 ID');
  const title = first('标题');
  const sourceCategory = first('分类');
  const sourceBrand = parseAttributes(sections.get('商品参数')).品牌 ?? '';
  const attributes = parseAttributes(sections.get('商品参数'));
  const brand = options.brand ?? 'rhode';
  const markup = options.markup ?? 10;
  const stock = options.stock ?? 1000;
  const issues = [];
  const warnings = [];

  if (!/^https:\/\/detail\.1688\.com\/offer\/\d+\.html/.test(sourceUrl)) issues.push('来源链接不是 1688 商品详情链接');
  if (!/^\d+$/.test(offerId)) issues.push('商品 ID 缺失或格式错误');
  if (!title) issues.push('标题缺失');
  if (!sourceCategory) issues.push('分类缺失');
  if (!Number.isFinite(markup) || markup < 0) issues.push('加价金额无效');
  if (!Number.isInteger(stock) || stock < 0) issues.push('库存必须是非负整数');

  const imageFiles = fs.readdirSync(imageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(imageDir, entry.name));
  const imageExtensions = ['jpg', 'jpeg', 'png', 'webp'];
  const mainImages = numberedFiles(imageFiles, '主图', imageExtensions);
  const detailImages = numberedFiles(imageFiles, '详情', imageExtensions);
  const videoFiles = numberedFiles(imageFiles, '视频', ['mp4']);
  const skuImages = new Map();
  for (const file of imageFiles) {
    const match = /^SKU-\d+-(.+)\.(jpg|jpeg|png|webp)$/i.exec(path.basename(file));
    if (!match) continue;
    const color = match[1].trim();
    if (skuImages.has(color)) issues.push(`颜色「${color}」存在多张 SKU 图`);
    skuImages.set(color, file);
  }
  if (!mainImages.length) issues.push('至少需要一张「主图-NN」图片');
  if (mainImages.length > 5) warnings.push(`有 ${mainImages.length} 张主图，千牛当前页面最多上传 5 张，将按编号使用前 5 张`);
  if (videoFiles.length > 1) warnings.push('只会使用第一段「视频-NN」文件');

  const skuLines = sections.get('规格') ?? [];
  const skuRows = [];
  const seenIds = new Set();
  const seenCombinations = new Set();
  for (const [index, line] of skuLines.entries()) {
    const match = SKU_LINE.exec(line);
    if (!match) {
      issues.push(`规格第 ${index + 1} 行无法解析：${line.slice(0, 100)}`);
      continue;
    }
    const [, colorRaw, sourceImage, modelRaw, sourceSkuId, priceRaw] = match;
    const color = colorRaw.trim();
    const model = modelRaw.trim();
    const purchasePrice = Number(priceRaw);
    const key = `${color}\u0000${model}`;
    if (!color || !model) issues.push(`规格第 ${index + 1} 行缺少颜色或型号`);
    if (`${color} / ${model}`.length > 128) issues.push(`规格第 ${index + 1} 行超过千牛的 128 字符限制`);
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) issues.push(`规格第 ${index + 1} 行进价无效`);
    if (seenIds.has(sourceSkuId)) issues.push(`重复的 1688 SKU ID：${sourceSkuId}`);
    if (seenCombinations.has(key)) issues.push(`重复规格组合：${color} / ${model}`);
    seenIds.add(sourceSkuId);
    seenCombinations.add(key);
    skuRows.push({
      color,
      model,
      sourceSkuId,
      sourceImage,
      skuImage: skuImages.get(color) ?? null,
      purchasePrice,
      salePrice: Math.round((purchasePrice + markup) * 100) / 100,
      stock,
    });
  }
  if (!skuRows.length) issues.push('没有可用的 SKU');
  const colors = [...new Set(skuRows.map((row) => row.color))];
  const models = [...new Set(skuRows.map((row) => row.model))];
  for (const color of colors) if (!skuImages.has(color)) issues.push(`颜色「${color}」缺少 SKU 图`);
  for (const color of skuImages.keys()) if (!colors.includes(color)) warnings.push(`SKU 图片「${color}」没有对应规格`);
  const skuPlan = buildSkuPlan(skuRows);
  issues.push(...skuPlan.issues);
  if (sourceBrand && sourceBrand.toLowerCase() !== brand.toLowerCase()) {
    warnings.push(`原始参数品牌是「${sourceBrand}」，目标品牌按设置使用「${brand}」`);
  }

  return {
    root,
    textFile,
    imageDir,
    offerId,
    sourceUrl,
    sourceCategory,
    sourceBrand,
    title,
    imageFolderName: imageFolderName(title),
    brand,
    attributes,
    mainImages: mainImages.slice(0, 5),
    skippedMainImages: mainImages.slice(5),
    detailImages,
    video: videoFiles[0] ?? null,
    skuRows,
    colors,
    models,
    skuPlan,
    issues,
    warnings,
  };
}

export function summarizeTemplate(template) {
  const prices = [...new Set(template.skuRows.map((row) => row.salePrice))].sort((a, b) => a - b);
  return {
    offerId: template.offerId,
    title: template.title,
    imageFolderName: template.imageFolderName,
    sourceCategory: template.sourceCategory,
    sourceBrand: template.sourceBrand,
    targetBrand: template.brand,
    skuCount: template.skuRows.length,
    targetSkuCount: template.skuPlan.rows.length,
    skuDisplay: template.skuPlan.mode === 'two-layer' ? '颜色分类 × 适用手机型号' : '单层展示',
    colorCount: template.colors.length,
    modelCount: template.models.length,
    targetModelCount: template.skuPlan.models.length,
    salePrices: prices,
    stockPerSku: template.skuRows[0]?.stock ?? 0,
    mainImages: template.mainImages.map((file) => path.basename(file)),
    detailImageCount: template.detailImages.length,
    skuImageCount: new Set(template.skuRows.map((row) => row.skuImage).filter(Boolean)).size,
    video: template.video ? path.basename(template.video) : null,
    issues: template.issues,
    warnings: template.warnings,
  };
}
