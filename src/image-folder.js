export const IMAGE_SPACE_URL = 'https://qn.taobao.com/home.htm/material-center/mine-material/sucai-tu?from=sucaitu';
const folderText = (name) => new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);

export function imageFolderName(title) {
  return Array.from(title.trim()).slice(0, 3).join('');
}

export async function ensureImageFolder(browser, folderName) {
  const page = await browser.contexts()[0].newPage();
  try {
    await page.goto(IMAGE_SPACE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const create = page.getByRole('button', { name: '新建文件夹' });
    await create.waitFor({ timeout: 30_000 });
    await page.locator('[class*="PicturesShow_main-document-show"]').first().waitFor({ timeout: 30_000 });
    if (await page.getByText(folderName, { exact: true }).count()) return false;

    const dialog = page.getByRole('dialog', { name: '新建文件夹' });
    for (let attempt = 0; attempt < 4 && !(await dialog.count()); attempt += 1) {
      // 首次进入图片空间可能出现活动弹窗或引导层。
      for (const selector of ['.CommonModal_dialog [aria-label="关闭"]', '.ImageTestGuide_dialog [aria-label="关闭"]']) {
        const close = page.locator(selector);
        if (await close.count()) await close.first().evaluate((button) => button.click());
      }
      await create.evaluate((button) => button.click());
      await dialog.waitFor({ timeout: 3_000 }).catch(() => {});
    }
    await dialog.waitFor({ timeout: 10_000 });
    await dialog.locator('[aria-valuetext]').first().waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] [aria-valuetext]')]
      .some((input) => input.getAttribute('aria-valuetext')), null, { timeout: 20_000 });
    const parent = await dialog.locator('[aria-valuetext]').first().getAttribute('aria-valuetext');
    if (parent !== '全部图片') throw new Error(`图片文件夹上级目录不符：${parent}`);
    await dialog.locator('input[maxlength="20"]').fill(folderName);
    await dialog.getByRole('button', { name: '确定' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 20_000 });
    await page.getByText(folderName, { exact: true }).first().waitFor({ timeout: 20_000 });
    return true;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function selectUploadFolder(frame, folderName) {
  const dir = frame.locator('#dir');
  await dir.waitFor({ timeout: 10_000 });
  if (await dir.getAttribute('aria-valuetext') !== folderName) {
    await dir.click();
    await dir.fill(folderName);
    await frame.getByRole('menuitem').filter({ hasText: folderText(folderName) }).first().click();
  }
  const selected = await dir.getAttribute('aria-valuetext');
  if (selected !== folderName) throw new Error(`图片上传目录未选中：期望 ${folderName}，实际 ${selected}`);
}

export async function selectGalleryFolder(frame, folderName) {
  const selected = frame.locator('.next-tree-node-inner.next-selected').first();
  if ((await selected.innerText().catch(() => '')).trim() === folderName) return;
  await frame.getByPlaceholder('请输入文件夹名称').fill(folderName);
  const option = frame.getByRole('option').filter({ hasText: folderText(folderName) }).first();
  await option.click();
  const actual = (await selected.innerText()).trim();
  if (actual !== folderName) throw new Error(`图片空间浏览目录未切换：期望 ${folderName}，实际 ${actual}`);
}
