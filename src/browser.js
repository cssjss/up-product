import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

export const DEBUG_URL = 'http://127.0.0.1:39333';
export const PUBLISH_URL = 'https://item.upload.taobao.com/sell/v2/publish.htm?catId=150704';

export async function connectEdge() {
  try {
    return await chromium.connectOverCDP(DEBUG_URL, { timeout: 10_000 });
  } catch (error) {
    throw new Error(`无法连接专用 Edge。先运行 bin/start-edge.ps1。原始错误：${error.message}`);
  }
}

export async function publishingPage(browser, { openIfMissing = true } = {}) {
  const context = browser.contexts()[0];
  if (!context) throw new Error('专用 Edge 中没有浏览器会话');
  let page = context.pages().find((candidate) => candidate.url().includes('item.upload.taobao.com/sell/v2/publish.htm?catId=150704'));
  if (!page && openIfMissing) {
    page = await context.newPage();
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  if (!page) throw new Error('专用 Edge 中没有千牛商品发布页');
  await page.bringToFront();
  return page;
}

export function assertLoggedIn(page) {
  if (page.url().includes('login.taobao.com')) {
    throw new Error('请先在专用 Edge 窗口登录千牛，再重新运行命令');
  }
}

export async function inspectPage(browser, artifactDir) {
  const page = await publishingPage(browser);
  assertLoggedIn(page);
  fs.mkdirSync(artifactDir, { recursive: true });
  const report = {
    url: page.url(),
    title: await page.title(),
    frames: [],
  };
  for (const frame of page.frames()) {
    try {
      const info = await frame.evaluate(() => {
        const controls = [...document.querySelectorAll('input, textarea, select, button, [role="button"], [contenteditable="true"]')];
        return {
          text: document.body?.innerText?.slice(0, 12_000) ?? '',
          controls: controls.slice(0, 350).map((element) => ({
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role'),
            type: element.getAttribute('type'),
            name: element.getAttribute('name'),
            id: element.id,
            className: String(element.className ?? '').slice(0, 180),
            placeholder: element.getAttribute('placeholder'),
            ariaLabel: element.getAttribute('aria-label'),
            text: element.innerText?.trim()?.slice(0, 150) ?? '',
            outerHTML: element.outerHTML.slice(0, 400),
          })),
        };
      });
      report.frames.push({ url: frame.url(), ...info });
    } catch (error) {
      report.frames.push({ url: frame.url(), error: error.message });
    }
  }
  const name = `inspect-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const jsonFile = path.join(artifactDir, `${name}.json`);
  const screenshotFile = path.join(artifactDir, `${name}.png`);
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
  await page.screenshot({ path: screenshotFile, fullPage: true, timeout: 30_000 });
  return { jsonFile, screenshotFile, report };
}
