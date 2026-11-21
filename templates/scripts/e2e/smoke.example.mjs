// 浏览器端到端冒烟验收（示例骨架）：在真实 Chromium 里打开构建产物，走一遍产品的核心路径。
// 启用：按项目改好“核心路径”一段，改名为 scripts/e2e/smoke.mjs；ci.yml 检测到该文件才会运行，失败即 CI 失败（不合并、不发布）。
// 用法：node scripts/e2e/smoke.mjs [地址]，默认 http://127.0.0.1:4173/
// 失败时退出码非 0，并把截图写到 E2E_ARTIFACTS（默认 e2e-artifacts/）供 CI 上传。
//
// 写法要点（都在真实审核里被打回过）：
// - 断言“结果”，不要只断言“页面打开了”：例如点击后某个数字真的变了、列表真的新增了一条。
// - 基线在所有前置动作（弹窗、自动发放的奖励等）处理完之后、关键动作之前读，否则前置动作的变化会冒充关键动作的结果。
// - 画布 / WebGL：回读像素前隐藏界面层，只留画布，避免界面颜色让空白画面蒙混过关。
// - 冒烟测试只走本机 preview 服务、不接触任何凭据；统计等上报逻辑要对本机地址关闭，免得 CI 写进正式数据。
import { chromium } from 'playwright';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:4173/';
const outDir = process.env.E2E_ARTIFACTS || 'e2e-artifacts';
mkdirSync(outDir, { recursive: true });

const errors = [];
const steps = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

async function step(name, fn) {
  try {
    await fn();
    steps.push(`✓ ${name}`);
  } catch (e) {
    steps.push(`✗ ${name}：${e.message}`);
    throw e;
  }
}

let ok = false;
try {
  await step('打开页面', async () => {
    await page.goto(base, { waitUntil: 'load', timeout: 30_000 });
    // 换成“应用已就绪”的可靠标志
    await page.locator('body').waitFor({ timeout: 20_000 });
  });

  // ===== 核心路径（按项目改写）=====
  // 示例：读基线 → 做关键动作 → 断言结果确实变化。
  // await step('点击“加一”后计数增加', async () => {
  //   const before = Number(await page.locator('#count').textContent());
  //   await page.locator('#inc').click();
  //   await page.waitForFunction((b) => Number(document.querySelector('#count')?.textContent) > b, before, { timeout: 5_000 });
  // });
  // ================================

  if (errors.length) throw new Error(`页面出现错误：\n${errors.join('\n')}`);
  ok = true;
} catch (e) {
  steps.push(`失败：${e.message}`);
} finally {
  await page.screenshot({ path: join(outDir, ok ? 'smoke-pass.png' : 'smoke-fail.png') }).catch(() => {});
  await browser.close();
}

console.log(steps.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 浏览器冒烟验收：${ok ? '通过' : '失败'}\n\n${steps.map((s) => `- ${s}`).join('\n')}\n`);
}
process.exit(ok ? 0 : 1);
