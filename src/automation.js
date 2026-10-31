import fs from 'node:fs';
import path from 'node:path';
import { PUBLISH_URL } from './browser.js';
import { ensureImageFolder, selectGalleryFolder, selectUploadFolder } from './image-folder.js';

const basename = (file) => path.basename(file);

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

async function selectorFrame(page, realtime) {
  await page.waitForFunction((value) => [...document.querySelectorAll('iframe')].some((e) =>
    e.src.includes('sucai-selector-ng') && e.src.includes(`realtime=${value}`)), realtime, { timeout: 20_000 });
  let frame;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    frame = page.frames().find((item) => item.url().includes('sucai-selector-ng') && item.url().includes(`realtime=${realtime}`));
    if (frame) break;
    await page.waitForTimeout(200);
  }
  if (!frame) throw new Error('千牛图片选择窗口未加载');
  await frame.getByRole('button', { name: '本地上传' }).waitFor({ timeout: 20_000 });
  return frame;
}

async function uploadImages(page, frame, files, folderName) {
  if (!files.length) return;
  const alreadyUploaded = await frame.locator('[class*="UploadPanel_fileItem"]').evaluateAll((items, names) => {
    const recent = items.slice(-names.length);
    return recent.length === names.length && recent.every((item, index) =>
      item.innerText.split('\n')[0] === names[index] && item.querySelector('.next-icon-success'));
  }, files.map(basename));
  if (!alreadyUploaded) {
    if (!(await frame.locator('input[type="file"]').count())) {
      await selectGalleryFolder(frame, folderName);
      await frame.getByRole('button', { name: '本地上传' }).click();
    }
    await selectUploadFolder(frame, folderName);
    const input = frame.locator('input[type="file"]').last();
    await input.waitFor({ state: 'attached', timeout: 10_000 });
    await input.setInputFiles(files);
  }
  await frame.waitForFunction((expected) => {
    const items = [...document.querySelectorAll('[class*="UploadPanel_fileItem"]')];
    return items.length >= expected && items.slice(-expected).every((item) => item.querySelector('.next-icon-success'));
  }, files.length, { timeout: Math.max(90_000, files.length * 10_000) });
  await frame.getByRole('button', { name: '完成' }).evaluate((element) => element.click());
  await selectGalleryFolder(frame, folderName);
  await frame.locator('[class*="PicList_pic_background"]').filter({ hasText: basename(files[0]) }).first().waitFor({ timeout: 20_000 });
  const assets = [];
  for (const file of files) {
    const tile = frame.locator('[class*="PicList_pic_background"]').filter({ hasText: basename(file) }).first();
    const source = await tile.locator('img').first().getAttribute('src');
    const id = source?.match(/O1CN[^_?~/]+/)?.[0];
    if (!id) throw new Error(`素材库未返回图片 ID：${basename(file)}`);
    assets.push({ name: basename(file), id });
  }
  log(`${files.length} 张图片已上传到图片空间「${folderName}」`);
  return new Map(assets.map((item) => [item.name, item.id]));
}

async function imageTile(frame, file, assetId) {
  let tile = frame.locator('[class*="PicList_pic_background"]').filter({ hasText: basename(file) });
  if (assetId) tile = tile.filter({ has: frame.locator(`img[src*="${assetId}"]`) });
  tile = tile.first();
  await tile.waitFor({ timeout: 15_000 });
  return tile;
}

async function fillBasics(page, template) {
  await page.locator('#sell-field-title input').fill(template.title);
  await page.locator('#struct-p-20000 input').click();
  const search = page.locator('.sell-o-select-popup-overlay .options-search input');
  await search.fill(template.brand);
  await page.locator('.options-item[title="RHODE"]').click();
  if (template.attributes.风格?.includes('简约')) {
    await page.locator('#struct-p-20608 input').click();
    await page.locator('.sell-o-select-popup-overlay .options-item[title="简约"]').click();
  }
  const title = await page.locator('#sell-field-title input').inputValue();
  if (title !== template.title) throw new Error('宝贝标题回填校验失败');
  const brand = await page.locator('#struct-p-20000 input').inputValue();
  if (brand.toUpperCase() !== 'RHODE') throw new Error(`品牌回填校验失败：${brand}`);
  log('标题、品牌及可匹配的风格已填写');
}

async function selectMode(drawer, label) {
  const mode = drawer.locator('.next-radio-wrapper').filter({ hasText: label });
  if (await mode.getAttribute('aria-checked') !== 'true') await mode.click();
  if (await mode.getAttribute('aria-checked') !== 'true') throw new Error(`千牛未切换到「${label}」`);
}

async function createSingleLayerSkus(page, drawer, template) {
  const mode = drawer.locator('.next-radio-wrapper').filter({ hasText: '单层展示·自定义填写规格' });
  await selectMode(drawer, '单层展示·自定义填写规格');
  await drawer.locator('input[placeholder="输入规格"]').waitFor({ timeout: 10_000 });
  if (await mode.getAttribute('aria-checked') !== 'true') throw new Error('千牛未切换到单层规格模式');
  const rows = template.skuPlan.rows;
  for (let index = 0; index < rows.length; index += 1) {
    const input = drawer.locator('input[placeholder="输入规格"]').last();
    const label = template.skuPlan.singleProperty === 'color' ? rows[index].color : rows[index].model;
    await input.fill(label);
    await input.press('Tab');
    if (index < rows.length - 1) {
      const add = drawer.locator('button.add').last();
      await add.waitFor({ state: 'visible' });
      await add.click();
    }
    if ((index + 1) % 25 === 0 || index === rows.length - 1) {
      const count = (await drawer.innerText()).match(/商品规格\((\d+)\)/)?.[1];
      if (count !== String(index + 1)) throw new Error(`规格创建进度不符：${count}/${index + 1}`);
      log(`规格已创建 ${index + 1}/${rows.length}`);
    }
  }
}

const optionKey = (value) => value.toLowerCase().replace(/\s+/g, '');

async function addStandardModel(page, drawer, model) {
  const group = drawer.locator('.sale-props-auto-crop-pic-common-wrap#struct-p-228680323');
  const input = group.locator('li.sell-component-common-sale-props-option-item').last().locator('input').first();
  await input.click();
  const popup = page.locator('.sell-cascader-select-sale-props-item-popup');
  const hasModel = async () => popup.getByRole('option').evaluateAll((options, key) =>
    options.some((option) => option.querySelector('[title]')?.getAttribute('title')?.toLowerCase().replace(/\s+/g, '') === key), optionKey(model));
  if (!(await hasModel())) await popup.getByRole('option').filter({ hasText: 'Apple/苹果' }).first().click();
  const index = await popup.getByRole('option').evaluateAll((options, key) => options.findIndex((option) =>
    option.querySelector('[title]')?.getAttribute('title')?.toLowerCase().replace(/\s+/g, '') === key), optionKey(model));
  if (index < 0) throw new Error(`千牛没有标准手机型号选项：${model}`);
  await popup.getByRole('option').nth(index).locator('label').click();
  await drawer.locator('.drawer-title').click();
  const actual = await input.inputValue();
  if (optionKey(actual) !== optionKey(model)) throw new Error(`手机型号回填不符：期望 ${model}，实际 ${actual}`);
}

async function addStandardColor(page, drawer, colorSpec) {
  const group = drawer.locator('.sale-props-auto-crop-pic-common-wrap#struct-p-1627207');
  const row = group.locator('li.sell-component-common-sale-props-option-item').last();
  const input = row.locator('input[placeholder="主色(必选)"]');
  await input.click();
  const popup = page.locator('.color-group-wrapper.sell-color-dropdown-wrapper');
  await popup.locator('.color-group-panel .color-tag').filter({ hasText: colorSpec.family }).click();
  const option = popup.locator('.colors-panel .color-tag').filter({ hasText: new RegExp(`^${colorSpec.base}$`) });
  await option.click();
  if (colorSpec.remark) {
    const remark = row.locator('input[placeholder="备注(可选)"]');
    await remark.fill(colorSpec.remark);
    await remark.press('Tab');
  }
  if (await input.inputValue() !== colorSpec.base) throw new Error(`颜色主色回填失败：${colorSpec.color}`);
}

async function fillColorLayerImages(page, drawer, template) {
  const specs = template.skuPlan.colors;
  const rows = drawer.locator('.sale-props-auto-crop-pic-common-wrap#struct-p-1627207 li.sell-component-common-sale-props-option-item');
  await rows.first().locator('.sell-color-option-image-empty').click();
  const dialog = page.locator('.batch-fill-sku-image-dialog');
  await dialog.waitFor({ timeout: 15_000 });
  const frame = await selectorFrame(page, true);
  const files = specs.map((spec) => spec.image);
  const assets = await uploadImages(page, frame, files, template.imageFolderName);
  const items = dialog.locator('li.sku-item');
  if (await items.count() !== specs.length) throw new Error('颜色层图片列表数量与模板不符');
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const item = items.nth(index);
    const displayed = (await item.locator('.sku-text').innerText()).trim();
    if (displayed !== spec.base) throw new Error(`颜色图片顺序不符：${spec.color} 显示为 ${displayed}`);
    if (!(await item.getAttribute('class')).includes('focused')) await item.evaluate((element) => element.click());
    const assetId = assets.get(basename(spec.image));
    if (!assetId) throw new Error(`无法核验颜色图片：${spec.color}`);
    const existing = await item.locator('.sku-image-container img').count()
      ? await item.locator('.sku-image-container img').getAttribute('src') : null;
    if (existing?.includes(assetId)) continue;
    const tile = await imageTile(frame, spec.image, assetId);
    if (await tile.locator('input[type="checkbox"]').getAttribute('aria-checked') === 'true') {
      await tile.locator('label').first().click();
      await tile.locator('input[type="checkbox"][aria-checked="false"]').waitFor({ timeout: 5_000 });
    }
    await tile.locator('label').first().click();
    await item.locator('.sku-image-container img').waitFor({ timeout: 20_000 });
    const applied = await item.locator('.sku-image-container img').getAttribute('src');
    if (!applied?.includes(assetId)) throw new Error(`颜色图片对应错误：${spec.color}`);
  }
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  if (await rows.locator('img.image-item').count() !== specs.length) throw new Error('颜色层图片未全部回填');
  log(`${specs.length} 张颜色层图片已回填`);
}

async function createLayeredSkus(page, drawer, template) {
  await selectMode(drawer, '分层展示·选择标准属性构建规格');
  const colorProperty = drawer.locator('.prop-item').filter({ hasText: '颜色分类' });
  if (!(await colorProperty.getAttribute('class')).includes('selected')) await colorProperty.click();
  const imageToggle = drawer.locator('.common-wrap#struct-p-1627207 label.pic');
  if (await imageToggle.locator('input').getAttribute('aria-checked') !== 'true') await imageToggle.click();
  const modelGroup = drawer.locator('.sale-props-auto-crop-pic-common-wrap#struct-p-228680323');
  for (const [index, model] of template.skuPlan.models.entries()) {
    await addStandardModel(page, drawer, model);
    if (index < template.skuPlan.models.length - 1) await modelGroup.locator('button.add').click();
    if ((index + 1) % 10 === 0) log(`标准手机型号已选择 ${index + 1}/${template.skuPlan.models.length}`);
  }
  const colorGroup = drawer.locator('.sale-props-auto-crop-pic-common-wrap#struct-p-1627207');
  for (const [index, spec] of template.skuPlan.colors.entries()) {
    await addStandardColor(page, drawer, spec);
    if (index < template.skuPlan.colors.length - 1) await colorGroup.locator('button.add').click();
  }
  await fillColorLayerImages(page, drawer, template);
  log(`${template.skuPlan.models.length} 个型号 × ${template.skuPlan.colors.length} 种颜色已配置`);
}

async function createSkus(page, template) {
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '+ 创建规格' }).click();
  const drawer = page.locator('.sku-decouple-drawer');
  if (template.skuPlan.mode === 'two-layer') await createLayeredSkus(page, drawer, template);
  else await createSingleLayerSkus(page, drawer, template);
  await drawer.getByRole('button', { name: '确认创建' }).click();
  await page.locator('#sell-field-sku').getByText('SKU模式').waitFor({ timeout: 30_000 });
  const skuText = await page.locator('#sell-field-sku').innerText();
  if (template.skuPlan.mode === 'two-layer' && !skuText.includes('多层展示')) throw new Error('千牛没有生成分层规格');
  if (!new RegExp(`\\/\\s*${template.skuPlan.rows.length}\\b`).test(skuText)) throw new Error(`千牛规格数量与模板计划不符：${template.skuPlan.rows.length}`);
}

async function fillVariablePrices(page, template) {
  const plan = template.skuPlan;
  const colorLabel = new Map(plan.colors.map((spec) => [spec.color, `${spec.base}${spec.remark ? `(${spec.remark})` : ''}`]));
  const rowKey = (row) => plan.mode === 'two-layer'
    ? `${row.model}\u0000${colorLabel.get(row.color)}`
    : (plan.singleProperty === 'color' ? row.color : row.model);
  const desired = new Map(plan.rows.map((row) => [rowKey(row), row.salePrice]));
  const seen = new Set();
  const scroller = page.locator('#sell-field-sku .ver-scroll-wrap').first();
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  for (let pass = 0; pass < 200 && seen.size < plan.rows.length; pass += 1) {
    const rows = await page.locator('#sell-field-sku [id$="-skuPrice"]').evaluateAll((cells) => cells.map((cell) => {
      const index = cell.id.split('-')[0];
      return {
        index,
        single: document.getElementById(`${index}-custom_-1`)?.querySelector('textarea[data-real="true"]')?.value?.trim(),
        model: document.getElementById(`${index}-p-228680323`)?.querySelector('[title]')?.getAttribute('title'),
        color: document.getElementById(`${index}-p-1627207`)?.querySelector('[title]')?.getAttribute('title'),
      };
    }));
    for (const row of rows) {
      const key = plan.mode === 'two-layer' ? `${row.model}\u0000${row.color}` : row.single;
      if (seen.has(key)) continue;
      const price = desired.get(key);
      if (price === undefined) throw new Error(`千牛规格与模板不一致：${key ?? row.index}`);
      const input = page.locator(`[id="${row.index}-skuPrice"] input`);
      await input.fill(price.toFixed(2));
      await input.press('Tab');
      if (Number(await input.inputValue()) !== price) throw new Error(`价格未回填：${key}`);
      seen.add(key);
    }
    const state = await scroller.evaluate((element) => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight, step: element.clientHeight * 0.7 }));
    if (state.top >= state.max - 2) break;
    await scroller.evaluate((element, next) => { element.scrollTop = next; }, Math.min(state.max, state.top + state.step));
    await page.waitForTimeout(150);
  }
  if (seen.size !== plan.rows.length) throw new Error(`逐条售价只核验 ${seen.size}/${plan.rows.length} 条`);
  log(`${seen.size} 条不同售价已逐条回填`);
}

async function fillPricesAndStock(page, template) {
  const prices = [...new Set(template.skuPlan.rows.map((row) => row.salePrice))];
  const stocks = [...new Set(template.skuPlan.rows.map((row) => row.stock))];
  if (stocks.length !== 1) throw new Error('当前页面仅支持统一库存');
  if (prices.length === 1) {
    await page.locator('#skuPrice').fill(prices[0].toFixed(2));
    await page.locator('#skuPrice').press('Tab');
    await page.getByRole('button', { name: '批量填写' }).evaluate((element) => element.click());
    await page.getByText('批量修改成功').waitFor({ timeout: 20_000 });
  } else {
    await fillVariablePrices(page, template);
  }
  await page.locator('#skuStock').fill(String(stocks[0]));
  await page.locator('#skuStock').press('Tab');
  await page.getByRole('button', { name: '批量填写' }).evaluate((element) => element.click());
  const visible = await page.locator('[id$="-skuPrice"] input').first().inputValue();
  if (prices.length === 1 && Number(visible) !== prices[0]) throw new Error(`SKU 售价校验失败：${visible}`);
  const visibleStock = await page.locator('[id$="-skuStock"] input').first().inputValue();
  if (Number(visibleStock) !== stocks[0]) throw new Error(`SKU 库存校验失败：${visibleStock}`);
  const totalStock = await page.locator('#sell-field-quantity input').inputValue();
  if (Number(totalStock) !== stocks[0] * template.skuPlan.rows.length) throw new Error(`总库存校验失败：${totalStock}`);
  log(`全部规格已按进价加价 10 元，库存 ${stocks[0]}`);
}

export async function fillMainImages(page, files, folderName) {
  if (await page.locator('#sell-field-mainImagesGroup .drag-item img').count() >= files.length) return;
  if (!page.frames().some((item) => item.url().includes('sucai-selector-ng') && item.url().includes('preCdnLinks=true'))) {
    await page.locator('#sell-field-mainImagesGroup .upload-text').first().click();
  }
  const frame = await selectorFrame(page, true);
  await uploadImages(page, frame, files, folderName);
  for (let index = 0; index < files.length; index += 1) {
    await (await imageTile(frame, files[index])).locator('label').first().click();
    await page.locator('#sell-field-mainImagesGroup .drag-item').nth(index).locator('img').first().waitFor({ timeout: 15_000 });
  }
  log(`${files.length} 张主图已回填`);
}

export async function fillDetailImages(page, files, folderName) {
  if (!files.length) return;
  if (await page.locator('#sell-field-descRepublicOfSell img.image-item').count() >= files.length) return;
  await page.locator('#sell-field-descRepublicOfSell [data-type="pic"]').click();
  const frame = await selectorFrame(page, false);
  await uploadImages(page, frame, files, folderName);
  for (const file of files) {
    const tile = await imageTile(frame, file);
    await tile.hover();
    const checkbox = tile.locator('input[type="checkbox"]');
    if (await checkbox.getAttribute('aria-checked') !== 'true') {
      await tile.locator('label[class*="PicList_checkbox"]').click();
    }
  }
  const chosen = await frame.locator('[class*="PicList_pic_background"] input[type="checkbox"][aria-checked="true"]').count();
  if (chosen !== files.length) throw new Error(`详情图选择数量不符：${chosen}/${files.length}`);
  await frame.getByRole('button', { name: new RegExp(`^确定（${files.length}）$`) }).click();
  await page.waitForFunction((count) => document.querySelectorAll('#sell-field-descRepublicOfSell img.image-item').length >= count,
    files.length, { timeout: 20_000 });
  log(`${files.length} 张详情图已回填`);
}

export async function fillVideo(page, file) {
  if (!file) return;
  if (await page.locator('#sell-field-auctionVideos .material-video-item[draggable="true"] img.cover').count()) return;
  await page.locator('#sell-field-auctionVideos .emptyVideo').first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((item) => item.src.includes('videoSelector.htm')),
    null, { timeout: 20_000 });
  let frame;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    frame = page.frames().find((item) => item.url().includes('videoSelector.htm'));
    if (frame) break;
    await page.waitForTimeout(200);
  }
  if (!frame) throw new Error('千牛视频选择窗口未加载');
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 });
  await frame.getByRole('button', { name: '本地上传' }).click();
  await (await chooserPromise).setFiles(file);
  await frame.getByText('发布成功').waitFor({ timeout: 120_000 });
  await frame.getByRole('button', { name: '完成' }).click();
  const search = frame.getByPlaceholder('搜索视频名称/ID');
  await search.fill(basename(file));
  await search.press('Enter');
  const card = frame.locator('[class*="VideoList--videoItem"]').filter({ hasText: basename(file) }).first();
  await card.waitFor({ timeout: 30_000 });
  await card.click();
  await frame.getByRole('button', { name: /确认上传/ }).click();
  await page.locator('#sell-field-auctionVideos .material-video-item[draggable="true"] img.cover').first().waitFor({ timeout: 20_000 });
  log('商品视频已回填');
}

export async function fillSkuImages(page, template, { reuseUploaded = false } = {}) {
  if (template.skuPlan.mode === 'two-layer') return;
  const dialog = page.locator('.batch-fill-sku-image-dialog');
  if (!(await dialog.count())) {
    const skuCell = page.locator('[id$="-skuPicture"] [class*="maskOverlay"]').first();
    await skuCell.evaluate((element) => element.click());
  }
  await dialog.waitFor({ timeout: 15_000 });
  const frame = await selectorFrame(page, true);
  const rowByName = new Map(template.skuPlan.rows.map((row) => [template.skuPlan.singleProperty === 'color' ? row.color : row.model, row]));
  const colorImage = new Map(template.skuPlan.rows.map((row) => [row.color, row.skuImage]));
  let assets;
  if (reuseUploaded) {
    assets = new Map();
    for (const file of new Set(colorImage.values())) {
      const source = await (await imageTile(frame, file)).locator('img').first().getAttribute('src');
      assets.set(basename(file), source?.match(/O1CN[^_?~/]+/)?.[0]);
    }
  } else {
    assets = await uploadImages(page, frame, [...new Set(colorImage.values())], template.imageFolderName);
  }
  const items = dialog.locator('li.sku-item');
  const names = await items.locator('.sku-text').allTextContents();
  const expected = new Set(rowByName.keys());
  if (names.length !== template.skuPlan.rows.length || names.some((name) => !expected.has(name.trim()))) {
    throw new Error('千牛 SKU 图片列表与模板规格不一致，已停止以避免配错图片');
  }
  for (let index = 0; index < names.length; index += 1) {
    const rowName = names[index].trim();
    const color = rowByName.get(rowName)?.color;
    const file = colorImage.get(color);
    if (!file) throw new Error(`找不到 SKU 图片：${rowName}`);
    const item = items.nth(index);
    if (await item.locator('.sku-image-container img').count()) continue;
    if (!(await item.getAttribute('class')).includes('focused')) await item.evaluate((element) => element.click());
    const sourceId = assets.get(basename(file));
    if (!sourceId) throw new Error(`无法核验上传的 SKU 图片：${basename(file)}`);
    const tile = await imageTile(frame, file, sourceId);
    if (await tile.locator('input[type="checkbox"]').getAttribute('aria-checked') === 'true') {
      await tile.locator('label').first().click();
      await tile.locator('input[type="checkbox"][aria-checked="false"]').waitFor({ timeout: 5_000 });
    }
    await tile.locator('label').first().click();
    await item.locator('.sku-image-container img').waitFor({ timeout: 20_000 });
    const applied = await item.locator('.sku-image-container img').getAttribute('src');
    if (sourceId && !applied?.includes(sourceId)) throw new Error(`SKU 图片对应错误：${rowName}`);
    if ((index + 1) % 25 === 0 || index === names.length - 1) log(`SKU 图片已填写 ${index + 1}/${names.length}`);
  }
  const count = Number((await dialog.locator('.sku-image-completion').innerText()).split('/')[0]);
  if (count !== names.length) throw new Error(`SKU 图片完成数量不符：${count}/${names.length}`);
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
}

export async function createDraft(browser, template, artifactDir) {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  fs.mkdirSync(artifactDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), template: template.root, steps: [], page: PUBLISH_URL };
  const step = async (name, action) => {
    log(name);
    await action();
    report.steps.push(name);
    fs.writeFileSync(path.join(artifactDir, 'latest-draft.json'), JSON.stringify(report, null, 2));
  };
  try {
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (page.url().includes('login.taobao.com')) {
      log('请在当前 Edge 标签页完成千牛登录；登录后会自动继续，最长等待 5 分钟');
      await page.waitForURL((url) => !url.href.includes('login.taobao.com'), { timeout: 300_000 });
      if (!page.url().includes('/sell/v2/publish.htm')) {
        await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
    }
    await page.getByRole('button', { name: '+ 创建规格' }).waitFor({ timeout: 45_000 });
    const category = await page.locator('body').innerText();
    if (!category.includes('手机保护套/壳') || !template.sourceCategory.includes('手机保护套')) {
      throw new Error('当前页面类目与模板不符，请先确认手机保护套类目');
    }
    await step('准备图片空间文件夹', async () => {
      const created = await ensureImageFolder(browser, template.imageFolderName);
      log(`图片空间文件夹「${template.imageFolderName}」${created ? '已创建' : '已存在'}`);
      await page.bringToFront();
    });
    await step('填写基础信息', () => fillBasics(page, template));
    await step('创建销售规格', () => createSkus(page, template));
    await step('填写价格和库存', () => fillPricesAndStock(page, template));
    await step('上传主图', () => fillMainImages(page, template.mainImages, template.imageFolderName));
    await step('上传详情图', () => fillDetailImages(page, template.detailImages, template.imageFolderName));
    await step('上传商品视频', () => fillVideo(page, template.video));
    await step('填写 SKU 图片', () => fillSkuImages(page, template));
    await step('保存草稿', async () => {
      await page.getByRole('button', { name: '保存草稿' }).click();
      await page.getByText(/最后保存于/).waitFor({ timeout: 30_000 });
    });
    report.completedAt = new Date().toISOString();
    report.page = page.url();
    fs.writeFileSync(path.join(artifactDir, 'latest-draft.json'), JSON.stringify(report, null, 2));
    log(`草稿已保存；页面：${page.url()}`);
    return report;
  } catch (error) {
    report.error = error.message;
    report.page = page.url();
    report.failedAt = new Date().toISOString();
    fs.writeFileSync(path.join(artifactDir, 'latest-draft.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: path.join(artifactDir, 'latest-error.png'), fullPage: true, timeout: 30_000 }).catch(() => {});
    throw error;
  }
}
