#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTemplate, summarizeTemplate } from './template.js';
import { connectEdge, inspectPage } from './browser.js';
import { createDraft } from './automation.js';

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');

async function main() {
  const [action, folder] = process.argv.slice(2);
  if (!['check-template', 'inspect', 'draft'].includes(action) || !folder) {
    throw new Error('用法：node src/cli.js <check-template|inspect|draft> <模板文件夹>');
  }
  const template = loadTemplate(folder);
  const summary = summarizeTemplate(template);
  console.log(JSON.stringify(summary, null, 2));
  if (template.issues.length) throw new Error(`模板有 ${template.issues.length} 项错误，请先修正`);
  if (action === 'check-template') return;

  const browser = await connectEdge();
  try {
    if (action === 'inspect') {
      const result = await inspectPage(browser, artifactDir);
      console.log(`页面检查：${result.jsonFile}`);
      console.log(`页面截图：${result.screenshotFile}`);
      return;
    }
    await createDraft(browser, template, artifactDir);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
