#!/usr/bin/env node
/**
 * devloop 审核方（用户 Mac 上常驻）：GPT 审核 + 合并后代码的 CI 测试 → 自动合并。见 docs/DEVLOOP.md。
 *
 *   node scripts/devloop/devloop.mjs watch [秒]                常驻：扫描 open PR，审核未审过的头部提交（默认 300 秒）
 *   node scripts/devloop/devloop.mjs review <PR号> [--no-merge] 审核一次
 *
 * 安全边界：本机不执行 PR 里的任何代码。
 * - 测试与构建：触发 GitHub Actions（ci.yml，workflow_dispatch），在一次性 runner 上把 PR 头部合并到当前 main 后再测；
 * - GPT 审核：Codex CLI 只读沙箱（-s read-only），并忽略仓库内的执行策略文件（--ignore-rules）；
 * - 合并：policy.decide 判定通过后，在测试基准上本地生成与 CI 相同的合并提交，普通推送到 main。
 *   main 若在测试后变化，推送是非快进而被拒绝 → 不会合入未经测试的组合（原子的“比较并交换”）。
 *   GitHub 发现 PR 头部已在 main 中，会把 PR 自动标为已合并。
 * 依赖：gh（已登录）、codex CLI、Node ≥ 22，只用 Node 内置模块。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCi } from './ci.mjs';
import { acquireLock, mergeAndPush, reviewCacheKey, uniqueDir, withWorktree } from './gitops.mjs';
import { decide, eligible, hasTerminal, lastFindings, limitMode, roundsUsed, shouldReview } from './policy.mjs';
import { createPrState } from './prstate.mjs';
import { drainPending, followUpItems } from './followups.mjs';
import { buildReviewPrompt, formatReview, touchesWorkflows, validateReview } from './review-format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(HERE, '../..');
const REPO = process.env.DEVLOOP_REPO; // 必填：owner/name
if (!REPO) {
  console.error('缺少环境变量 DEVLOOP_REPO（owner/name）');
  process.exit(2);
}
const HOME = resolve(process.env.DEVLOOP_HOME ?? join(REPO_DIR, '..', 'devloop-home'));
/** 审核模型：不设则用 Codex CLI 自身配置的默认模型 */
const REVIEW_MODEL = process.env.DEVLOOP_REVIEW_MODEL ?? '';
const CI_TIMEOUT_MS = 30 * 60_000;

const log = (...a) => console.error(`[devloop ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 20) => s.split('\n').slice(-n).join('\n');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
}
const gh = (args) => sh('gh', [...args, '-R', REPO]);
const git = (args, cwd = REPO_DIR) => sh('git', args, { cwd });

/** 标记签名密钥：只在本机，首次运行生成，权限 600 */
function markerKey() {
  mkdirSync(HOME, { recursive: true });
  const f = join(HOME, 'marker.key');
  if (!existsSync(f)) {
    writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  return readFileSync(f, 'utf8').trim();
}
const KEY = markerKey();
/** PR 状态与审核方标记；审核方账号每次重新查询（原因见 prstate.mjs，测试见 prstate.test.mjs） */
const prState = createPrState({ gh: (args) => sh('gh', args), repo: REPO, key: KEY });

function comment(pr, body) {
  mkdirSync(HOME, { recursive: true });
  const f = join(HOME, `comment-${pr}-${Date.now()}.md`);
  writeFileSync(f, body);
  gh(['pr', 'comment', String(pr), '--body-file', f]);
}

/** CI 的真实 io：经 gh 访问 GitHub（供 ci.mjs 的 runCi 使用；runCi 会把这里的任何异常转为 status=error） */
const ciIo = {
  dispatch: async ({ pr, head, base, nonce }) => {
    gh(['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', `pr=${pr}`, '-f', `head=${head}`, '-f', `base=${base}`, '-f', `nonce=${nonce}`]);
  },
  listDispatchRuns: async () =>
    JSON.parse(gh(['run', 'list', '--workflow', 'ci.yml', '--event', 'workflow_dispatch', '--limit', '30', '--json', 'displayTitle,status,conclusion,url'])),
  listPrRuns: async (head) => JSON.parse(sh('gh', ['api', `repos/${REPO}/actions/runs?event=pull_request&head_sha=${head}&per_page=20`])).workflow_runs ?? [],
  sleep,
  now: () => Date.now(),
};

/** GPT 只读审核 PR 头部提交 */
function gptReview(pr, meta, base) {
  mkdirSync(HOME, { recursive: true });
  // 缓存键 = head + base：只有代码和基准都没变时才复用结论（main 变了就重新审核）
  const cache = join(HOME, reviewCacheKey(pr, meta.headRefOid, base));
  if (existsSync(cache)) {
    const cached = JSON.parse(readFileSync(cache, 'utf8'));
    if (!validateReview(cached)) return cached;
    rmSync(cache, { force: true }); // 旧版本缓存的不合法结论：丢弃重审
  }
  return withWorktree(REPO_DIR, uniqueDir(HOME, `pr-${pr}`), meta.headRefOid, (dir) => {
    const stat = sh('git', ['diff', '--stat', `${base}...${meta.headRefOid}`], { cwd: dir });
    const prompt = buildReviewPrompt({ header: readFileSync(join(HERE, 'review-prompt.md'), 'utf8'), pr, meta, base, stat });
    const out = `${cache}.${process.pid}.tmp`;
    log(`GPT（${REVIEW_MODEL || 'Codex 默认模型'}）审核 #${pr} @ ${meta.headRefOid.slice(0, 8)}`);
    const r = spawnSync(
      'codex',
      ['exec', ...(REVIEW_MODEL ? ['-m', REVIEW_MODEL] : []), '-c', 'model_reasoning_effort="high"', '-s', 'read-only', '--ignore-rules', '-C', dir, '--ephemeral',
        '--output-schema', join(HERE, 'review-schema.json'), '-o', out, '-'],
      { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 40 * 60_000 },
    );
    if (r.status !== 0 || !existsSync(out)) throw new Error(`codex 审核失败：${tail(`${r.stdout}${r.stderr}`)}`);
    const review = JSON.parse(readFileSync(out, 'utf8'));
    const bad = validateReview(review);
    if (bad) throw new Error(`codex 结论不符合 review-schema.json：${bad}`);
    writeFileSync(cache, JSON.stringify(review));
    rmSync(out, { force: true });
    return review;
  });
}

const format = (args) => formatReview({ ...args, key: KEY, model: REVIEW_MODEL || 'Codex 默认模型', where: '经 devloop 审核' });

export async function review(pr, { merge }) {
  const release = await acquireLock();
  if (!release) throw new Error('另一个 devloop 进程正在审核或合并，稍后再试');
  try {
    return await reviewLocked(pr, { merge });
  } finally {
    await release();
  }
}

async function reviewLocked(pr, { merge }) {
  git(['fetch', '-q', 'origin', 'main', `pull/${pr}/head`]);
  const meta = prState(pr);
  if (!eligible(meta)) throw new Error(`PR #${pr} 不是“打开、非草稿、目标 main”（state=${meta.state} draft=${meta.isDraft} base=${meta.baseRefName}）`);
  git(['fetch', '-q', 'origin', 'main', `pull/${pr}/head`]);
  const base = git(['rev-parse', 'origin/main']);
  const head = meta.headRefOid;

  const ciPromise = runCi({ pr, head, base, io: ciIo, timeoutMs: CI_TIMEOUT_MS });
  let rv = null;
  let reviewError = null;
  try {
    rv = gptReview(pr, meta, base);
  } catch (e) {
    reviewError = e.message.split('\n')[0];
    log(`#${pr} GPT 审核失败：${reviewError}`);
  }
  const ci = await ciPromise;

  const now = prState(pr);
  if (now.headRefOid !== head) {
    log(`#${pr} 审核期间有新提交（${head.slice(0, 8)} → ${now.headRefOid.slice(0, 8)}），本轮作废`);
    return { pr, skipped: 'head changed' };
  }
  if (hasTerminal(now.markers, head)) {
    log(`#${pr} 该提交在审核期间已被另一审核方处理（有终态标记），本轮作废`);
    return { pr, skipped: 'already decided' };
  }
  git(['fetch', '-q', 'origin', 'main']);
  const d = decide({
    ci,
    review: rv,
    now: { labels: now.labels, base: git(['rev-parse', 'origin/main']), mergeable: now.mergeable, state: now.state, isDraft: now.isDraft, baseRefName: now.baseRefName },
    roundsBefore: roundsUsed(now.markers),
    retriesForHead: now.markers.filter((m) => m.head === head && m.state === 'retry' && m.reason === 'infra').length,
    allowMerge: merge,
    mode: roundLimitMode(),
    prevFindings: lastFindings(now.markers),
  });
  if (d.addLabel) gh(['pr', 'edit', String(pr), '--add-label', d.addLabel]);
  if (d.merge) {
    try {
      const { sha, branchDeleted } = mergeAndPush({
        repoDir: REPO_DIR,
        home: HOME,
        base: ci.base,
        head,
        message: `合并 PR #${pr}：${now.title}\n\ndevloop：GPT 审核通过，CI 在 ${ci.base.slice(0, 8)} + ${head.slice(0, 8)} 上测试通过。`,
        branch: now.isCrossRepository ? null : now.headRefName,
        // 推送前一刻再读一次 PR：已关闭 / 改草稿 / 改目标 / 有新提交 / 加了暂停标签 → 中止
        beforePush: () => {
          const last = prState(pr);
          if (!eligible(last) || last.headRefOid !== head || last.labels.some((l) => l === 'hold' || l === 'needs-user') || hasTerminal(last.markers, head)) {
            throw new Error('推送前 PR 状态已变化');
          }
        },
      });
      d.text += `\n\n合并提交 \`${sha.slice(0, 8)}\`（父提交：main \`${ci.base.slice(0, 8)}\` + PR \`${head.slice(0, 8)}\`，与 CI 测试的组合一致）${branchDeleted ? '' : '；分支上有新提交或已删除，未删除分支'}。`;
    } catch (e) {
      d.state = 'retry';
      d.reason = 'merge';
      d.merge = false;
      d.text = `审核与测试都通过，但合并未完成（${e.message.split('\n')[0]}），下一轮扫描重试。`;
    }
  }
  // auto 模式轮次用满合并：先把遗留意见待办清单落盘，再发评论；评论失败不影响补开 issue（见 followups.mjs）
  if (d.state === 'merged' && d.followUpFindings?.length) savePending(pr, followUpItems({ pr, head, findings: d.followUpFindings }));
  try {
    comment(pr, format({ pr, head, review: rv ?? { verdict: 'error', summary: `GPT 审核未能完成：${reviewError}`, findings: [] }, ci, d }));
  } catch (e) {
    if (d.state !== 'merged') throw e;
    log(`#${pr} 已合并，但审核评论发送失败：${e.message.split('\n')[0]}`);
  }
  await processPending({ locked: true });
  const result = { pr, head, state: d.state, ci: ci.status, verdict: rv?.verdict ?? 'error', findings: rv?.findings.length ?? 0 };
  console.log(JSON.stringify(result));
  return result;
}

/** 遗留意见待办清单：<HOME>/followups/pr-<N>.json；全部开成功才删除，否则每轮 watch 继续补（幂等，不会重复开） */
const PENDING_DIR = join(HOME, 'followups');
function savePending(pr, items) {
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(join(PENDING_DIR, `pr-${pr}.json`), JSON.stringify({ pr, items }));
}

/** locked：调用方（reviewLocked）已持有进程锁；否则（watch 每轮）在这里获取同一把锁，忙则跳过本轮 */
async function processPending({ locked = false } = {}) {
  return drainPending({
    dir: PENDING_DIR,
    acquire: locked ? async () => () => {} : acquireLock,
    io: {
      list: () => sh('gh', ['api', '--paginate', `repos/${REPO}/issues?labels=devloop&state=all&per_page=100`, '--jq', '.[] | {number, body}'])
        .split('\n').filter(Boolean).map((l) => JSON.parse(l)),
      create: (it) => {
        const f = join(HOME, `issue-${Date.now()}.md`);
        writeFileSync(f, it.body);
        return gh(['issue', 'create', '--title', it.title, '--body-file', f, '--label', 'devloop']);
      },
      comment: (pr, text) => comment(pr, text),
      flag: (pr) => gh(['pr', 'edit', String(pr), '--add-label', 'needs-user']),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    },
  });
}

/** 轮次用满后的处理方式：仓库变量 ROUND_LIMIT_MODE（needs-user | auto），查询失败按 needs-user */
function roundLimitMode() {
  try {
    return limitMode(gh(['variable', 'get', 'ROUND_LIMIT_MODE']).trim());
  } catch {
    return 'needs-user';
  }
}

function cloudReviewOn() {
  try {
    return gh(['variable', 'get', 'CLOUD_REVIEW']).trim() === 'on';
  } catch {
    return false; // 变量不存在或查询失败：按未开启处理，本机照常审核全部 PR
  }
}

async function watch(intervalSec) {
  log(`watch 启动：间隔 ${intervalSec}s，审核模型 ${REVIEW_MODEL || 'Codex 默认'}，代码 ${git(['rev-parse', '--short', 'HEAD'])}`);
  for (;;) {
    try {
      await processPending(); // 已合并 PR 的遗留意见 issue 没开齐的，每轮继续补
      const prs = JSON.parse(gh(['pr', 'list', '--state', 'open', '--base', 'main', '--json', 'number', '--limit', '50']));
      for (const { number } of prs.sort((a, b) => a.number - b.number)) {
        const m = prState(number);
        if (!shouldReview({ head: m.headRefOid, labels: m.labels, markers: m.markers, pr: m })) continue;
        // 云端审核开启（仓库变量 CLOUD_REVIEW=on）后，本机只兜底改动工作流文件的 PR（云端令牌无 workflows 权限合并不了）
        if (cloudReviewOn() && !touchesWorkflows(m.files)) continue;
        try {
          const r = await review(number, { merge: true });
          // 合并后退出，由 launchd 重启并拉取最新 main：审核方自身的更新也随之生效
          if (r.state === 'merged') {
            log(`#${number} 已合并，退出以便以最新 main 重启`);
            process.exit(0);
          }
        } catch (e) {
          log(`#${number} 出错：${e.message}`);
        }
      }
    } catch (e) {
      log(`扫描出错：${e.message}`);
    }
    await sleep(intervalSec * 1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'review' && arg) await review(Number(arg), { merge: !rest.includes('--no-merge') });
    else if (cmd === 'watch') await watch(Number(arg) || 300);
    else {
      console.error('用法：devloop.mjs review <PR号> [--no-merge] | watch [秒]');
      process.exit(2);
    }
  } catch (e) {
    log(`失败：${e.message}`);
    process.exit(1);
  }
}
