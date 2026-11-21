#!/usr/bin/env node
/**
 * 云端 PR 审核（.github/workflows/gpt-review.yml 调用）。与本机 devloop.mjs 共用 policy / gitops / ci / prstate / review-format，
 * 同一把签名密钥（secret DEVLOOP_MARKER_KEY），所以两边的审核记录互认。
 *
 *   node cloud.mjs select [--pr N]                      选出一个要审的 PR → $GITHUB_OUTPUT：pr、head、base
 *   node cloud.mjs prompt --pr N --head H --base B --dir D --out F   在 PR 检出目录 D 里生成审核提示词（核对 H = PR 当前 head = 检出 HEAD）
 *   node cloud.mjs decide --pr N --head H --base B --review-result R [--review review.json --meta meta.json]   跑 CI、判定、合并或退回、评论、触发后续
 *
 * 分工：云端只审“不改 .github/workflows/”的 PR（GITHUB_TOKEN 无 workflows 权限，合并不了这类 PR），这类交给本机审核方。
 * 环境：GH_TOKEN（gh 使用）、REPO、DEVLOOP_MARKER_KEY、GPT_MODEL（仅用于评论里标注模型名）。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCi } from './ci.mjs';
import { mergeAndPush } from './gitops.mjs';
import { decide, eligible, hasTerminal, lastFindings, limitMode, roundsUsed, shouldReview } from './policy.mjs';
import { createPrState } from './prstate.mjs';
import { ensureFollowUps, followUpItems } from './followups.mjs';
import { buildReviewPrompt, formatReview, touchesWorkflows, validateReview } from './review-format.mjs';
import { acceptanceGate, followUpsAccept, isInFlight, loadGates, ownerAcceptance, queueBlocker, runIdOf } from './accept.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const out = (kv) => {
  const text = Object.entries(kv).map(([k, v]) => `${k}=${v ?? ''}`).join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  process.stdout.write(text);
};

/**
 * 选择逻辑（纯函数，便于测试）：按编号从小到大，取第一个需要审、且不改工作流的 PR。
 * gates（gates.json，可省略 = 不启用验收与排期）：
 *   - 等用户视觉验收（带 waitLabel、还没有 acceptLabel）的 PR 不审，免得反复花审核费用；
 *   - 合并排期：与编号更小、仍在途的 PR 改了同一文件 → 排队等它合完（accept.mjs queueBlocker）。
 */
export function pickPr(states, gates = null) {
  for (const m of [...states].sort((a, b) => a.number - b.number)) {
    if (!shouldReview({ head: m.headRefOid, labels: m.labels, markers: m.markers, pr: m })) continue;
    if (touchesWorkflows(m.files)) continue;
    if (gates && !isInFlight(m, gates.visual)) continue;
    if (gates && queueBlocker(m, states, gates.visual)) continue;
    return m;
  }
  return null;
}

/** 从 Actions 运行地址取运行号 */
export { runIdOf };

/** 合并后的后续：需修改 → 直接触发云端 Claude 修复（GITHUB_TOKEN 发的评论不会触发 issue_comment 工作流）；合并 → 触发部署 */
export function followUps(state, pr, accept = null) {
  if (state === 'changes') return [['workflow', 'run', 'claude.yml', '-f', `pr=${pr}`]];
  // 改画面的 PR 审核与测试都通过：发预览 + 视觉评分（accept.yml），等用户确认
  if (state === 'retry' && accept) return followUpsAccept(pr, accept);
  if (state === 'merged') return [['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', 'deploy_main=true']];
  return [];
}

/** 本机审核方账号 = 仓库所有者（各 agent 共用用户的 GitHub 账号）；云端据此与 github-actions 一起认签名标记 */
export function trustedReviewer(env) {
  const owner = env.LOCAL_REVIEWER || env.GITHUB_REPOSITORY_OWNER || '';
  if (!owner) throw new Error('缺少 LOCAL_REVIEWER / GITHUB_REPOSITORY_OWNER，无法识别本机审核记录');
  return owner;
}

async function withRetry(fn, { attempts, sleep, delayMs }) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw last;
}

/**
 * 发评论与后续动作，失败可见、可恢复：
 * - 合并时先触发部署、再发评论（评论失败不影响部署）；需修改时先发评论（Claude 修复要读它）、再触发修复；
 * - 每个动作有界重试；最终仍失败 → 给 PR 加 needs-user，并（尽力）发一条说明，写明要手动执行的命令，然后抛错让本次运行失败。
 *   不会重复合并（合并已完成），也不新增审核标记（不累计轮次）。
 */
export async function finalize({ ghR, pr, state, body, writeBody, accept = null, issues = [], listIssues = () => [], attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delayMs = 5000 }) {
  const failed = [];
  const tryDo = async (label, args) => {
    try {
      await withRetry(() => ghR(args), { attempts, sleep, delayMs });
    } catch (e) {
      failed.push({ label, cmd: `gh ${args.join(' ')}`, err: String(e.message).split('\n')[0] });
    }
  };
  const comment = () => tryDo('发审核评论', ['pr', 'comment', String(pr), '--body-file', writeBody(body)]);
  const follow = async () => {
    for (const a of followUps(state, pr, accept)) await tryDo(state === 'merged' ? '触发部署' : accept ? '触发预览与视觉验收' : '触发云端 Claude 修复', a);
  };
  if (state === 'merged') {
    await follow();
    await comment();
    // auto 模式轮次用满合并：遗留意见逐条开 devloop issue（幂等，见 followups.mjs）；
    // GITHUB_TOKEN 打的标签不会触发 claude.yml，所以对新开的 issue 直接按 issue 触发实现
    if (issues.length) {
      const r = await ensureFollowUps(issues, {
        list: () => listIssues(),
        create: (it) => ghR(['issue', 'create', '--title', it.title, '--body-file', writeBody(it.body), '--label', 'devloop']),
        sleep,
      }, { attempts, delayMs });
      for (const f of r.failed) failed.push({ label: '开遗留意见 issue', cmd: `手动补开 devloop issue，正文末尾附 <!-- devloop-followup key=${f.key} -->（已有同标识的 issue 则不必再开）`, err: f.err });
      // 对本次确认存在的全部遗留 issue 触发实现，包括“创建成功但响应丢失、重新核对时找回”的那些（它们不在 created 里，
      // 但同样从未触发过）。finalize 对同一提交只运行一次（判定前有终态去重），所以这里不会重复启动。
      const all = Object.values(r.numbers);
      for (const n of all) await tryDo(`触发 issue #${n} 的实现`, ['workflow', 'run', 'claude.yml', '-f', `issue=${n}`]);
      if (all.length) await tryDo('发遗留意见清单', ['pr', 'comment', String(pr), '--body-file', writeBody(`执行者：devloop（云端审核）\n\n遗留意见已转为 devloop issue：${all.map((n) => `#${n}`).join('、')}`)]);
    }
  } else {
    await comment();
    if (!failed.length) await follow(); // 评论没发出去就不触发修复（Claude 读不到意见）
    else failed.push(...followUps(state, pr, accept).map((a) => ({ label: '未触发（评论失败）', cmd: `gh ${a.join(' ')}`, err: '' })));
  }
  if (!failed.length) return;
  const note = ['执行者：devloop（云端审核）', '', `以下动作重试 ${attempts} 次后仍失败，自动循环在此停下（已加 needs-user）。排除原因后手动执行：`, '',
    ...failed.map((f) => `- ${f.label}：\`${f.cmd}\`${f.err ? `（${f.err}）` : ''}`),
    ...(failed.some((f) => f.label === '发审核评论') ? ['', '审核评论未能发出；可手动重跑本次云端审核：`gh workflow run gpt-review.yml -f pr=' + pr + '`'] : [])].join('\n');
  try { ghR(['pr', 'edit', String(pr), '--add-label', 'needs-user']); } catch { /* 尽力 */ }
  try { ghR(['pr', 'comment', String(pr), '--body-file', writeBody(note)]); } catch { /* 尽力 */ }
  throw new Error(`后续动作失败：${failed.map((f) => f.label).join('、')}`);
}

/**
 * 读取本次 review 任务的结论，并逐项核对它属于本次判定：
 * - review 任务本次没成功（reviewResult ≠ success）→ 一律不读结论，按基础设施问题处理；
 *   GitHub 重跑保留 run_id，若按固定名字下载，可能拿到上一次尝试、针对旧提交的 approve；
 * - 产物元数据（review 任务里由工作流步骤、而非模型写入）的 pr / head / base 必须与本次判定一致；
 * - 结论须符合 review-schema.json（validateReview），否则同样按基础设施问题处理、计入重试上限。
 * 返回 { review, reviewError }；review 为 null 时 reviewError 说明原因。
 */
export function loadReview({ reviewResult, reviewPath, metaPath, pr, head, base, read = (f) => readFileSync(f, 'utf8'), exists = existsSync }) {
  if (reviewResult !== 'success') return { review: null, reviewError: `GPT 审核任务本次未成功（${reviewResult || '未知'}），不采用任何旧结论` };
  if (!metaPath || !exists(metaPath) || !reviewPath || !exists(reviewPath)) return { review: null, reviewError: 'GPT 审核任务没有产出结论' };
  let meta;
  let review;
  try {
    meta = JSON.parse(read(metaPath));
    review = JSON.parse(read(reviewPath));
  } catch (e) {
    return { review: null, reviewError: `GPT 结论无法解析：${e.message}` };
  }
  const want = { pr: String(pr), head, base };
  for (const k of Object.keys(want)) {
    if (String(meta[k] ?? '') !== want[k]) return { review: null, reviewError: `GPT 结论与本次判定不符（${k}：${String(meta[k] ?? '').slice(0, 12)} ≠ ${want[k].slice(0, 12)}）` };
  }
  const bad = validateReview(review);
  if (bad) return { review: null, reviewError: `GPT 结论不符合 review-schema.json：${bad}` };
  return { review, reviewError: '' };
}

/**
 * decide 编排（入口级测试见 cloud.test.mjs）：读结论 → CI → 重新核对 PR → 判定 → 合并推送 → 评论与后续。
 * io：{ key, model, limitMode?, ghR, prState, mainSha, runCi({pr,head,base}), fetch(pr), mergeAndPush(opts), writeBody, sleep? }
 * 返回 { state, ci?, verdict?, reason? }；跳过时不评论、不触发任何后续。
 */
export async function runDecide({ pr, head, base, reviewResult, reviewPath, metaPath, read, exists }, io) {
  const { review, reviewError } = loadReview({ reviewResult, reviewPath, metaPath, pr, head, base, ...(read ? { read } : {}), ...(exists ? { exists } : {}) });
  const ci = await io.runCi({ pr, head, base });
  const now = io.prState(pr);
  if (now.headRefOid !== head) return { state: 'skipped', reason: `审核期间有新提交（${head.slice(0, 8)} → ${now.headRefOid.slice(0, 8)}）` };
  if (touchesWorkflows(now.files)) return { state: 'skipped', reason: '改动工作流文件，交给本机审核方' };
  // 该 head 已有终态标记（decide 重放，或审核期间另一个审核方已写入 changes / merged / stopped）→ 不再判定、不评论、不触发
  if (hasTerminal(now.markers, head)) return { state: 'skipped', reason: '该提交已有审核终态标记' };
  let d = decide({
    ci,
    review,
    now: { labels: now.labels, base: io.mainSha(), mergeable: now.mergeable, state: now.state, isDraft: now.isDraft, baseRefName: now.baseRefName },
    roundsBefore: roundsUsed(now.markers),
    retriesForHead: now.markers.filter((m) => m.head === head && m.state === 'retry' && m.reason === 'infra').length,
    allowMerge: true,
    mode: limitMode(io.limitMode),
    prevFindings: lastFindings(now.markers),
  });
  // 发布把关（gates.json）：改画面的 PR 合并前要用户确认（accept.mjs acceptanceGate，本机 devloop.mjs 用同一个）
  let accept = null;
  ({ d, accept } = acceptanceGate({ d, pr, head, files: now.files, markers: now.markers, gates: io.gates, acceptance: io.acceptance, ghR: io.ghR, runUrl: ci.url }));
  if (d.addLabel) io.ghR(['pr', 'edit', String(pr), '--add-label', d.addLabel]);
  if (d.merge) {
    try {
      io.fetch(pr);
      const { sha, branchDeleted } = io.mergeAndPush({
        base: ci.base,
        head,
        message: `合并 PR #${pr}：${now.title}\n\ndevloop（云端审核）：GPT 审核通过，CI 在 ${ci.base.slice(0, 8)} + ${head.slice(0, 8)} 上测试通过。`,
        branch: now.isCrossRepository ? null : now.headRefName,
        beforePush: () => {
          const last = io.prState(pr);
          if (!eligible(last) || last.headRefOid !== head || last.labels.some((l) => l === 'hold' || l === 'needs-user') || touchesWorkflows(last.files) || hasTerminal(last.markers, head)) throw new Error('推送前 PR 状态已变化');
        },
      });
      d.text += `\n\n合并提交 \`${sha.slice(0, 8)}\`（父提交：main \`${ci.base.slice(0, 8)}\` + PR \`${head.slice(0, 8)}\`，与 CI 测试的组合一致）${branchDeleted ? '' : '；分支上有新提交或已删除，未删除分支'}。`;
    } catch (e) {
      d.state = 'retry';
      d.reason = 'merge';
      d.merge = false;
      d.text = `审核与测试都通过，但合并未完成（${String(e.message).split('\n')[0]}），下一轮重试。`;
    }
  }
  const body = formatReview({
    key: io.key,
    model: io.model,
    where: '云端审核，openai/codex-action',
    pr,
    head,
    review: review ?? { verdict: 'error', summary: `GPT 审核未能完成：${reviewError}`, findings: [] },
    ci,
    d,
  });
  const issues = d.state === 'merged' && d.followUpFindings?.length ? followUpItems({ pr, head, findings: d.followUpFindings }) : [];
  await finalize({ ghR: io.ghR, pr, state: d.state, body, writeBody: io.writeBody, accept, issues, listIssues: io.listIssues, ...(io.sleep ? { sleep: io.sleep } : {}) });
  return { state: d.state, ci: ci.status, verdict: review?.verdict ?? 'error' };
}

/** 打开与关闭的 devloop issue（REST 列表，强一致）：[{ number, body }] */
export function listDevloopIssues(gh, repo) {
  return gh(['api', '--paginate', `repos/${repo}/issues?labels=devloop&state=all&per_page=100`, '--jq', '.[] | {number, body}'])
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const REPO = process.env.REPO;
  const KEY = process.env.DEVLOOP_MARKER_KEY;
  if (!REPO || !KEY) throw new Error('缺少 REPO 或 DEVLOOP_MARKER_KEY');
  const gh = (args) => sh('gh', args);
  const ghR = (args) => sh('gh', [...args, '-R', REPO]);
  // 可信审核方 = 本机审核方账号（仓库所有者）+ github-actions（prstate 自动加入）；签名仍逐条校验
  const prState = createPrState({ gh, repo: REPO, key: KEY, whoami: () => trustedReviewer(process.env) });
  const mainSha = () => gh(['api', `repos/${REPO}/commits/main`, '-q', '.sha']);
  const cmd = process.argv[2];

  if (cmd === 'select') {
    const only = arg('pr');
    const numbers = only ? [Number(only)] : JSON.parse(ghR(['pr', 'list', '--state', 'open', '--base', 'main', '--json', 'number', '--limit', '50'])).map((p) => p.number);
    const states = numbers.map((n) => ({ number: n, ...prState(n) }));
    const m = pickPr(states, loadGates());
    if (!m) return out({ pr: '', head: '', base: '', reason: '没有需要云端审核的 PR' });
    return out({ pr: m.number, head: m.headRefOid, base: mainSha(), reason: `审核 #${m.number}` });
  }

  if (cmd === 'prompt') {
    const pr = Number(arg('pr'));
    const base = arg('base');
    const head = arg('head');
    if (!/^[0-9a-f]{40}$/.test(head ?? '')) throw new Error('prompt 需要 --head <select 选定的 40 位 SHA>');
    // select 选定的 head、PR 当前 head、工作区检出的 HEAD 三者必须一致；提示词与 diff 一律用这个固定 SHA
    const meta = prState(pr);
    const checkout = sh('git', ['rev-parse', 'HEAD'], { cwd: arg('dir') });
    if (meta.headRefOid !== head || checkout !== head) {
      throw new Error(`审核对象不一致（选定 ${head.slice(0, 8)}，PR 当前 ${meta.headRefOid.slice(0, 8)}，检出 ${checkout.slice(0, 8)}），本轮终止`);
    }
    const stat = sh('git', ['diff', '--stat', `${base}...${head}`], { cwd: arg('dir') });
    writeFileSync(arg('out'), buildReviewPrompt({ header: readFileSync(join(HERE, 'review-prompt.md'), 'utf8'), pr, meta: { ...meta, headRefOid: head }, base, stat }));
    return out({ prompt: arg('out') });
  }

  if (cmd === 'decide') {
    const ciIo = {
      dispatch: async ({ pr: p, head: h, base: b, nonce }) => ghR(['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', `pr=${p}`, '-f', `head=${h}`, '-f', `base=${b}`, '-f', `nonce=${nonce}`]),
      listDispatchRuns: async () => JSON.parse(ghR(['run', 'list', '--workflow', 'ci.yml', '--event', 'workflow_dispatch', '--limit', '30', '--json', 'displayTitle,status,conclusion,url'])),
      listPrRuns: async (h) => JSON.parse(gh(['api', `repos/${REPO}/actions/runs?event=pull_request&head_sha=${h}&per_page=20`])).workflow_runs ?? [],
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    };
    const r = await runDecide(
      { pr: Number(arg('pr')), head: arg('head'), base: arg('base'), reviewResult: arg('review-result'), reviewPath: arg('review'), metaPath: arg('meta') },
      {
        key: KEY,
        model: process.env.GPT_MODEL || 'GPT',
        limitMode: process.env.ROUND_LIMIT_MODE,
        listIssues: () => listDevloopIssues(gh, REPO),
        ghR,
        prState,
        mainSha,
        gates: loadGates(),
        // accepted 标签：最后一次由仓库所有者打上、且晚于当前 head 的“等待验收”标记才算数（accept.mjs acceptanceState）
        acceptance: ownerAcceptance({ gh, repo: REPO, owner: trustedReviewer(process.env), label: loadGates()?.visual.acceptLabel }),
        runCi: (p) => runCi({ ...p, io: ciIo, timeoutMs: 30 * 60_000 }),
        fetch: (pr) => sh('git', ['fetch', '-q', 'origin', 'main', `pull/${pr}/head`]),
        mergeAndPush: (opts) => mergeAndPush({ repoDir: process.cwd(), home: mkdtempSync(join(tmpdir(), 'cloud-merge-')), ...opts }),
        writeBody: (text) => {
          const f = join(mkdtempSync(join(tmpdir(), 'cloud-comment-')), 'c.md');
          writeFileSync(f, text);
          return f;
        },
      },
    );
    return out(r);
  }
  throw new Error('用法：cloud.mjs select|prompt|decide …');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(`[cloud-review] 失败：${e.message}`);
    process.exit(1);
  });
}
