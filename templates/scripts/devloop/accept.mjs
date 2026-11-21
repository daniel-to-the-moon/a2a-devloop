#!/usr/bin/env node
/**
 * 验收与发布角色的判定逻辑（纯函数为主，accept.test.mjs 覆盖）。配置在 gates.json。
 *
 * - 合并排期：isInFlight / queueBlocker —— 改同一文件的 PR 按编号排队，前面的合完后面的再审（避免互相冲突、反复返工）。
 * - 发布把关：isVisual / acceptanceState —— 改画面的 PR 在代码审核与 CI 都通过后，先发预览、跑视觉评分，等用户加 accepted 标签才合并。
 *   accepted 必须由仓库所有者打、且晚于当前 head 的提交时间（之后有新提交就要重新确认）。
 * - 视觉验收结果：reportPlan —— 根据评分结论决定：等用户确认 / 交 Claude 修 / 停下等用户。
 *
 *   node accept.mjs report --pr N --head H --judge judge.json --preview URL --run-url URL   （accept.yml report 任务：发评论、改标签、需要时触发修复）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eligible, hasSkipLabel } from './policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** gates.json 不存在 → null（验收与排期模块未安装，云端审核照旧） */
export const loadGates = (read = (f) => readFileSync(f, 'utf8'), exists = existsSync) => (exists(join(HERE, 'gates.json')) ? JSON.parse(read(join(HERE, 'gates.json'))) : null);
export const VISUAL_PREFIX = '执行者：devloop（视觉验收）';

/** 路径规则：以 / 结尾为目录前缀，否则为精确文件 */
const hit = (file, rules) => rules.some((r) => (r.endsWith('/') ? file.startsWith(r) : file === r));
export const isVisual = (files, visual) => files.some((f) => hit(f, visual.paths));

/** PR 是否“在途”：会继续自动推进（打开、非草稿、目标 main、没有等人的标签）。等用户的 PR 不挡别人，免得整条队伍卡在人身上 */
export function isInFlight(pr, visual) {
  if (!eligible(pr) || hasSkipLabel(pr.labels)) return false;
  return !(pr.labels.includes(visual.waitLabel) && !pr.labels.includes(visual.acceptLabel));
}

/** 合并排期：编号更小、仍在途、与 m 改了同一文件的 PR → 返回它的编号（m 排在它后面）；没有则 null */
export function queueBlocker(m, all, visual) {
  const mine = new Set(m.files);
  const older = all.filter((o) => o.number < m.number && isInFlight(o, visual) && o.files.some((f) => mine.has(f)));
  return older.length ? Math.min(...older.map((o) => o.number)) : null;
}

/**
 * events：issue 事件（REST /issues/N/events），[{ event, label: { name }, actor: { login }, created_at }]，时间升序。
 * 返回 'accepted'（最后一次相关事件是所有者打上标签，且晚于 headAt）| 'stale'（标签在，但早于当前 head）| 'none'
 */
export function acceptanceState({ events, owner, headAt, label }) {
  const last = [...events].reverse().find((e) => (e.event === 'labeled' || e.event === 'unlabeled') && e.label?.name === label);
  if (!last || last.event !== 'labeled' || last.actor?.login !== owner) return 'none';
  return Date.parse(last.created_at) >= Date.parse(headAt) ? 'accepted' : 'stale';
}

/** 已有几轮视觉验收未达标（以评论计） */
export const visualRounds = (comments) => comments.filter((c) => c.body.startsWith(VISUAL_PREFIX) && c.body.includes('结论：未达标')).length;

/**
 * 根据评分结论决定下一步与评论内容。
 * judge：visual-judge.mjs 的输出；preview：预览地址（可空，发布失败时）；rounds：此前未达标轮数。
 * 返回 { action: 'await' | 'fix' | 'stop', labelsAdd, labelsRemove, body }
 */
export function reportPlan({ pr, head, judge, preview, runUrl, rounds, maxRounds, visual }) {
  const lines = [VISUAL_PREFIX, ''];
  lines.push(`PR #${pr} 的代码审核与合并后测试已通过；本 PR 改动画面，合并前需要视觉验收（提交 \`${head.slice(0, 8)}\`）。`, '');
  lines.push(preview ? `- 预览地址（需 Cloudflare Access 登录）：${preview}` : '- 预览发布失败，见运行日志');
  lines.push(`- 截图与性能数据：${runUrl}（Actions 产物）`);
  if (judge?.scores) {
    const s = judge.scores;
    lines.push(`- 模型评分（${judge.model}）：配色 ${s.palette} · 造型 ${s.shape} · 光照 ${s.lighting} · 可读性 ${s.readability} · 不退步 ${s.regression}，平均 ${judge.overall}`);
  }
  if (judge?.notes?.length) lines.push('', '评分意见：', ...judge.notes.map((n) => `- ${n}`));
  lines.push('');
  if (judge?.verdict === 'fail') {
    if (rounds + 1 >= maxRounds) {
      lines.push(`结论：未达标（${judge.reason}）。已 ${rounds + 1} 轮未达标（上限 ${maxRounds}），停下等用户决定（已加 needs-user）。`);
      return { action: 'stop', labelsAdd: ['needs-user'], labelsRemove: [visual.waitLabel], body: lines.join('\n') };
    }
    lines.push(`结论：未达标（${judge.reason}）。交给云端 Claude 按上面的意见修改（第 ${rounds + 1} 轮，上限 ${maxRounds}）。`);
    return { action: 'fix', labelsAdd: [], labelsRemove: [visual.waitLabel], body: lines.join('\n') };
  }
  const why = judge?.verdict === 'pass' ? '模型评分达标' : `模型评分没有完成（${judge?.reason ?? '未知原因'}），请直接人工看`;
  lines.push(`结论：${why}，等你拍板。满意就给本 PR 加 \`${visual.acceptLabel}\` 标签，下一轮自动合并；不满意就在下面写意见。`);
  return { action: 'await', labelsAdd: [visual.waitLabel], labelsRemove: [], body: lines.join('\n') };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2] === 'report') {
  const REPO = process.env.REPO;
  const gh = (args) => execFileSync('gh', [...args, '-R', REPO], { encoding: 'utf8' }).trim();
  const gates = loadGates();
  const pr = Number(arg('pr'));
  const head = arg('head');
  let judge = null;
  try { judge = JSON.parse(readFileSync(arg('judge'), 'utf8')); } catch { judge = { verdict: 'error', reason: '没有评分结果' }; }
  const now = JSON.parse(gh(['pr', 'view', String(pr), '--json', 'headRefOid,state,comments']));
  if (now.state !== 'OPEN' || now.headRefOid !== head) {
    console.log(`跳过：PR 已关闭或有新提交（${String(now.headRefOid).slice(0, 8)}）`);
    process.exit(0);
  }
  const plan = reportPlan({ pr, head, judge, preview: arg('preview') || '', runUrl: arg('run-url'), rounds: visualRounds(now.comments.map((c) => ({ body: c.body }))), maxRounds: gates.judge.maxRounds, visual: gates.visual });
  const f = join(mkdtempSync(join(tmpdir(), 'accept-')), 'c.md');
  writeFileSync(f, plan.body);
  gh(['pr', 'comment', String(pr), '--body-file', f]);
  for (const l of plan.labelsAdd) gh(['pr', 'edit', String(pr), '--add-label', l]);
  for (const l of plan.labelsRemove) { try { gh(['pr', 'edit', String(pr), '--remove-label', l]); } catch { /* 标签不在 */ } }
  if (plan.action === 'fix') gh(['workflow', 'run', 'claude.yml', '-f', `pr=${pr}`]);
  console.log(`视觉验收：${plan.action}`);
}
