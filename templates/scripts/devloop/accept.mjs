#!/usr/bin/env node
/**
 * 验收与发布角色的判定逻辑（纯函数为主，accept.test.mjs 覆盖）。配置在 gates.json。
 *
 * - 合并排期：isInFlight / queueBlocker —— 改同一文件的 PR 按编号排队，前面的合完后面的再审（避免互相冲突、反复返工）。
 * - 发布把关：isVisual / acceptanceState —— 改画面的 PR 在代码审核与 CI 都通过后，先发预览、跑视觉评分，等用户加 accepted 标签才合并。
 *   accepted 必须由仓库所有者打、且晚于针对当前 head 的“等待验收”签名标记（换了 head 就要重新确认）。
 *   acceptanceGate 是云端与本机共用的合并前置条件。
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
import { CLOUD_REVIEWER_LOGINS } from './review-format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** gates.json 不存在 → null（验收与排期模块未安装，云端审核照旧） */
export const loadGates = (read = (f) => readFileSync(f, 'utf8'), exists = existsSync) => (exists(join(HERE, 'gates.json')) ? JSON.parse(read(join(HERE, 'gates.json'))) : null);
export const VISUAL_PREFIX = '执行者：devloop（视觉验收）';

/** 路径规则：以 / 结尾为目录前缀，否则为精确文件 */
const hit = (file, rules) => rules.some((r) => (r.endsWith('/') ? file.startsWith(r) : file === r));
export const isVisual = (files, visual) => files.some((f) => hit(f, visual.paths));

/** 该 PR 当前 head 是否正在等用户视觉验收：有等待标签、没有确认标签，且最后一条 retry:accept 标记就是当前 head（换了 head 就重新处理） */
export function isAwaiting(pr, visual) {
  if (!pr.labels.includes(visual.waitLabel) || pr.labels.includes(visual.acceptLabel)) return false;
  const last = [...(pr.markers ?? [])].reverse().find((m) => m.state === 'retry' && m.reason === 'accept');
  return Boolean(last && last.head === pr.headRefOid);
}

/** PR 是否“在途”：会继续自动推进（打开、非草稿、目标 main、没有等人的标签）。等用户的 PR 不挡别人，免得整条队伍卡在人身上 */
export function isInFlight(pr, visual) {
  if (!eligible(pr) || hasSkipLabel(pr.labels)) return false;
  return !isAwaiting(pr, visual);
}

/** 合并排期：编号更小、仍在途、与 m 改了同一文件的 PR → 返回它的编号（m 排在它后面）；没有则 null */
export function queueBlocker(m, all, visual) {
  const mine = new Set(m.files);
  const older = all.filter((o) => o.number < m.number && isInFlight(o, visual) && o.files.some((f) => mine.has(f)));
  return older.length ? Math.min(...older.map((o) => o.number)) : null;
}

/**
 * 用户确认是否对当前 head 有效。
 * markers：PR 上的签名标记（带评论时间 at）；只有“最后一条 retry:accept 标记”针对的正是当前 head，
 * 且仓库所有者在这条标记之后打上 accepted（之后没被摘掉），才算 'accepted'。
 * 这样确认绑定在“被评分、被预览的那个 head”上：换了 head（包括推一个更早的提交）一律要重新验收，不看提交时间。
 * events：issue 事件（REST /issues/N/events），[{ event, label: { name }, actor: { login }, created_at }]，时间升序。
 * 返回 'accepted' | 'stale'（标签在，但不对应当前 head 的验收）| 'none'
 */
export function acceptanceState({ events, owner, label, markers, head }) {
  const last = [...events].reverse().find((e) => (e.event === 'labeled' || e.event === 'unlabeled') && e.label?.name === label);
  if (!last || last.event !== 'labeled' || last.actor?.login !== owner) return 'none';
  const wait = [...(markers ?? [])].reverse().find((m) => m.state === 'retry' && m.reason === 'accept');
  if (!wait || wait.head !== head || !wait.at) return 'stale';
  return Date.parse(last.created_at) > Date.parse(wait.at) ? 'accepted' : 'stale';
}

/** 已有几轮视觉验收未达标（以评论计） */
/** 已有几轮视觉验收未达标：只数云端身份（github-actions）发的报告，别人仿写同样开头的评论不算，免得被人耗光修复轮次 */
export const visualRounds = (comments) => comments.filter((c) => CLOUD_REVIEWER_LOGINS.includes(c.author) && c.body.startsWith(VISUAL_PREFIX) && c.body.includes('结论：未达标')).length;

export const runIdOf = (url) => /\/actions\/runs\/(\d+)/.exec(url ?? '')?.[1] ?? null;

/** 验收用到的两个标签：[名称, 颜色, 说明] */
export const acceptLabels = (visual) => [
  [visual.waitLabel, 'FBCA04', '等用户视觉验收（看预览后加 accepted）'],
  [visual.acceptLabel, '0E8A16', '用户已确认画面，可以合并'],
];

/**
 * 合并前的发布把关，云端（cloud.mjs）与本机（devloop.mjs）共用同一个前置条件，任何入口都绕不过。
 * d：policy.decide 的结果；只在 d.merge 且改了画面、且用户没确认当前 head 时介入：
 * 改为 retry:accept（不合并），确保标签存在并加等待标签由调用方按 d.addLabel 处理，返回需要触发的 accept.yml 参数。
 * acceptance(pr, head, markers) → acceptanceState 的结果。返回 { d, accept: { head, run } | null }
 */
export function acceptanceGate({ d, pr, head, files, markers, gates, acceptance, ghR, runUrl }) {
  if (!d.merge || !gates || !isVisual(files, gates.visual)) return { d, accept: null };
  const acc = acceptance(pr, head, markers);
  if (acc === 'accepted') return { d, accept: null };
  // 标签不存在时 gh pr edit --add-label 会失败：先确保两个标签都在（--force 已存在则只更新）
  for (const [name, color, desc] of acceptLabels(gates.visual)) {
    try { ghR(['label', 'create', name, '--color', color, '--description', desc, '--force']); } catch { /* 尽力；随后加标签失败会让本次运行失败 */ }
  }
  if (acc === 'stale') { try { ghR(['pr', 'edit', String(pr), '--remove-label', gates.visual.acceptLabel]); } catch { /* 尽力 */ } }
  const nd = {
    state: 'retry', reason: 'accept', merge: false, addLabel: gates.visual.waitLabel,
    text: `审核通过 + 合并后代码测试通过。本 PR 改动画面，合并前需要视觉验收${acc === 'stale' ? '（之前的 accepted 不对应最新提交，已失效）' : ''}：正在发布预览并评分，结果会另发一条评论；用户加 \`${gates.visual.acceptLabel}\` 标签后下一轮合并。`,
  };
  const run = runIdOf(runUrl);
  if (!run) nd.text += '\n\n（拿不到 CI 运行号，未能触发预览；可手动运行 accept.yml。）';
  return { d: nd, accept: run ? { head, run } : null };
}

/** 需要触发的 accept.yml（gh 参数列表，不含 -R） */
export const followUpsAccept = (pr, accept) => (accept ? [['workflow', 'run', 'accept.yml', '--ref', 'main', '-f', `pr=${pr}`, '-f', `head=${accept.head}`, '-f', `run=${accept.run}`]] : []);

/** acceptance(pr, head, markers)：读 PR 的标签事件，按 acceptanceState 判定。owner：唯一能确认的账号（仓库所有者） */
export const ownerAcceptance = ({ gh, repo, owner, label }) => (p, h, markers) => acceptanceState({
  events: JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${p}/events?per_page=100`])).flat(),
  owner,
  label,
  markers,
  head: h,
});

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
  const plan = reportPlan({ pr, head, judge, preview: arg('preview') || '', runUrl: arg('run-url'), rounds: visualRounds(now.comments.map((c) => ({ author: c.author?.login ?? '', body: c.body }))), maxRounds: gates.judge.maxRounds, visual: gates.visual });
  const f = join(mkdtempSync(join(tmpdir(), 'accept-')), 'c.md');
  writeFileSync(f, plan.body);
  gh(['pr', 'comment', String(pr), '--body-file', f]);
  for (const l of plan.labelsAdd) gh(['pr', 'edit', String(pr), '--add-label', l]);
  for (const l of plan.labelsRemove) { try { gh(['pr', 'edit', String(pr), '--remove-label', l]); } catch { /* 标签不在 */ } }
  if (plan.action === 'fix') gh(['workflow', 'run', 'claude.yml', '-f', `pr=${pr}`]);
  console.log(`视觉验收：${plan.action}`);
}
