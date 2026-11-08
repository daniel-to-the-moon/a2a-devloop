/**
 * devloop 决策逻辑（无网络、无文件 I/O），由 policy.test.mjs 覆盖。
 *
 * 每条审核评论末尾带一个签名的机器标记（每条评论只认最后一个）：
 *   <!-- devloop pr=<编号> state=<状态>:<原因> head=<提交> base=<提交> sig=<HMAC> -->
 *   changes  需要执行者改（GPT 要求修改 / 测试失败 / 冲突）→ 触发云端 Claude 修复；同一 head 不再审
 *   merged   已合并
 *   stopped  达到轮次上限，加 needs-user，停止自动循环
 *   retry    暂时不能合并（暂停标签、main 在测试后变化、合并失败、CI 基础设施出错、--no-merge）→ 下一轮重试
 *
 * 防伪：签名密钥只存在审核方本机（$DEVLOOP_HOME/marker.key），不进仓库也不进 GitHub；
 * 并且只认审核方账号发出、以“执行者：GPT”开头的评论。其他评论里写的标记一律无效。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_ROUNDS = 5;
/** 同一个 head 因基础设施问题（CI 未完成、GPT 审核失败）重试的上限，达到即停下等用户 */
export const MAX_CI_RETRIES = 3;
/**
 * 轮次用满后的处理方式（仓库变量 ROUND_LIMIT_MODE，用户自选，默认 needs-user）：
 * - needs-user：停下、加 needs-user，等用户裁决（原行为）；
 * - auto：免人工裁决——意见数逐轮减少时自动追加轮次（最多 EXTRA_ROUNDS 轮）；
 *   不再减少或追加轮次用完时，若剩余意见没有 blocker、CI 通过、无冲突，则合并并把剩余意见逐条转成 devloop issue；
 *   出现 blocker 或意见数比上一轮多 → 仍停下加 needs-user。
 */
export const LIMIT_MODES = ['needs-user', 'auto'];
export const EXTRA_ROUNDS = 3;
export function limitMode(v) {
  return LIMIT_MODES.includes(v) ? v : 'needs-user';
}
export const SKIP_LABELS = ['needs-user', 'hold'];
const TERMINAL = new Set(['changes', 'merged', 'stopped']);
const REVIEW_PREFIX = '执行者：GPT';

function sign(key, pr, state, head, base) {
  return createHmac('sha256', key).update(`${pr}|${state}|${head}|${base}`).digest('hex').slice(0, 32);
}

export function marker(key, { pr, state, head, base, reason = 'none' }) {
  const st = `${state}:${reason}`;
  return `<!-- devloop pr=${pr} state=${st} head=${head} base=${base} sig=${sign(key, pr, st, head, base)} -->`;
}

/**
 * comments: [{ author, body }]；reviewer：审核方 GitHub 账号（字符串或数组：本机审核方账号 + 云端审核的 github-actions）。
 * 返回有效标记（签名正确、作者是审核方、评论以审核前缀开头、PR 号一致），每条评论至多一个。
 */
export function parseMarkers(comments, { key, reviewer, pr }) {
  const out = [];
  for (const c of comments) {
    if (![].concat(reviewer).includes(c.author) || !c.body.startsWith(REVIEW_PREFIX)) continue;
    const all = [...c.body.matchAll(/<!-- devloop pr=(\d+) state=(\w+:\w+) head=([0-9a-f]{40}) base=([0-9a-f]{40}) sig=([0-9a-f]{32}) -->/g)];
    const m = all.at(-1);
    if (!m || Number(m[1]) !== pr) continue;
    const want = Buffer.from(sign(key, m[1], m[2], m[3], m[4]));
    const got = Buffer.from(m[5]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) continue;
    const [state, reason] = m[2].split(':');
    out.push({ state, reason, head: m[3], base: m[4] });
  }
  return out;
}

export function hasSkipLabel(labels) {
  return labels.some((l) => SKIP_LABELS.includes(l));
}

/** PR 是否处在可以自动处理的状态：打开、非草稿、目标为 main */
export function eligible({ state, isDraft, baseRefName }) {
  return state === 'OPEN' && !isDraft && baseRefName === 'main';
}

/** watch 是否要审这个 PR 的当前 head */
export function shouldReview({ head, labels, markers, pr }) {
  if (pr && !eligible(pr)) return false;
  if (hasSkipLabel(labels)) return false;
  return !markers.some((m) => m.head === head && TERMINAL.has(m.state));
}

/** 已经消耗的轮次 = 得到 changes 结论的不同 head 数 */
/** 该 head 是否已有终态标记（changes / merged / stopped）：已被某个审核方处理过，判定与推送都应跳过 */
export function hasTerminal(markers, head) {
  return markers.some((m) => m.head === head && TERMINAL.has(m.state));
}

export function roundsUsed(markers) {
  return new Set(markers.filter((m) => m.state === 'changes').map((m) => m.head)).size;
}

/** 最近一条 changes 标记记下的意见数（reason = f<n>；旧标记没有记录时返回 null） */
export function lastFindings(markers) {
  const m = [...markers].reverse().find((x) => x.state === 'changes');
  const n = /^f(\d+)$/.exec(m?.reason ?? '');
  return n ? Number(n[1]) : null;
}

export function isBlocking(findings) {
  return findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
}

/**
 * 合并前的最终决定。
 * ci: { status: 'ok' | 'failed' | 'error', base }，base 为 CI 实际测试的基准提交
 * now: { labels, base, mergeable, state, isDraft, baseRefName }：决定前一刻重新读取的 PR 状态与 main
 */
export function decide({ ci, review, now, roundsBefore, allowMerge, retriesForHead = 0, mode = 'needs-user', prevFindings = null }) {
  // PR 在审核期间被关闭、改成草稿、改投其他分支：本轮作废，不合并、不写终态
  if (!eligible({ state: now.state ?? 'OPEN', isDraft: now.isDraft ?? false, baseRefName: now.baseRefName ?? 'main' })) {
    return { state: 'retry', merge: false, text: 'PR 已不是“打开、非草稿、目标 main”的状态，本轮结论不生效。' };
  }
  // 暂停标签最先判断：审核期间被暂停的 PR 只记 retry，去掉标签后会重新审核（不写终态）
  if (hasSkipLabel(now.labels)) {
    return { state: 'retry', merge: false, text: `PR 带有 ${now.labels.filter((l) => SKIP_LABELS.includes(l)).join('、')} 标签，本轮结论不生效；去掉标签后重新审核。` };
  }
  // 基础设施问题：CI 未能完成，或 GPT 审核本身失败（review 为 null）。同一提交累计到上限即停
  if (ci.status === 'error' || !review) {
    const what = !review ? 'GPT 审核未能完成' : 'CI 未能完成';
    if (retriesForHead + 1 >= MAX_CI_RETRIES) {
      return { state: 'stopped', reason: 'infra', merge: false, addLabel: 'needs-user', text: `同一提交已 ${retriesForHead + 1} 次因基础设施问题无法判定（本次：${what}），达到上限 ${MAX_CI_RETRIES}，停止自动循环，请用户检查（已加 needs-user 标签）。` };
    }
    return { state: 'retry', reason: 'infra', merge: false, text: `${what}（基础设施问题，第 ${retriesForHead + 1} 次），下一轮扫描重试。` };
  }
  const approved = review.verdict === 'approve' && !isBlocking(review.findings);
  const needsChange = ci.status === 'failed' || !approved || now.mergeable === 'CONFLICTING';
  if (needsChange) {
    const round = roundsBefore + 1;
    const n = review.findings.length;
    const fReason = `f${n}`; // changes 标记记下本轮意见数，供 auto 模式判断是否在收敛
    if (round >= MAX_ROUNDS && limitMode(mode) === 'auto') {
      const stop = (why) => ({ state: 'stopped', reason: 'limit', merge: false, addLabel: 'needs-user', text: `已 ${round} 轮未通过（轮次上限 ${MAX_ROUNDS}，auto 模式）：${why}，停止自动循环，请用户裁决（已加 needs-user 标签）。` });
      if (review.findings.some((f) => f.severity === 'blocker')) return stop('仍有 blocker');
      if (prevFindings !== null && n > prevFindings) return stop(`意见数比上一轮多（${prevFindings} → ${n}）`);
      const falling = prevFindings !== null && n < prevFindings;
      const canMerge = ci.status === 'ok' && now.mergeable !== 'CONFLICTING';
      if ((falling || !canMerge) && round < MAX_ROUNDS + EXTRA_ROUNDS) {
        const why = !canMerge ? (ci.status === 'failed' ? '测试或构建失败' : '与基准分支冲突') : `意见在收敛（${prevFindings} → ${n}）`;
        return { state: 'changes', reason: fReason, merge: false, text: `第 ${round} 轮未通过，auto 模式追加轮次（${why}；最多到第 ${MAX_ROUNDS + EXTRA_ROUNDS} 轮）。执行者修复后自动重新审核。` };
      }
      if (!canMerge) return stop(ci.status === 'failed' ? '追加轮次用完，测试或构建仍失败' : '追加轮次用完，仍与基准分支冲突');
      if (!allowMerge) return { state: 'retry', merge: false, text: '轮次用满、auto 模式可合并（本次指定 --no-merge，未合并）。' };
      if (ci.base !== now.base) return { state: 'retry', merge: false, text: '测试之后 main 有了新提交，下一轮用新 main 重新审核与测试。' };
      return {
        state: 'merged', reason: 'limit', merge: true, followUpFindings: review.findings,
        text: `已 ${round} 轮，auto 模式：剩余 ${n} 条意见均非 blocker、CI 通过 → 合并，剩余意见逐条转成 devloop issue。`,
      };
    }
    if (round >= MAX_ROUNDS) {
      return { state: 'stopped', merge: false, addLabel: 'needs-user', text: `已连续 ${round} 轮未通过，达到上限 ${MAX_ROUNDS}，停止自动循环，请用户裁决（已加 needs-user 标签）。` };
    }
    const why = [
      ci.status === 'failed' ? '测试或构建失败' : null,
      !approved ? 'GPT 要求修改' : null,
      now.mergeable === 'CONFLICTING' ? '与基准分支冲突（先 git merge origin/main）' : null,
    ].filter(Boolean);
    return { state: 'changes', reason: fReason, merge: false, text: `第 ${round} 轮未通过：${why.join('；')}。执行者修复后自动重新审核。` };
  }
  if (!allowMerge) return { state: 'retry', merge: false, text: '审核通过（本次指定 --no-merge，未合并）。' };
  if (ci.base !== now.base) return { state: 'retry', merge: false, text: '测试之后 main 有了新提交，测试结果不再代表合并后的代码，下一轮用新 main 重新审核与测试。' };
  return { state: 'merged', merge: true, text: '审核通过 + 合并后代码测试通过 → 合并（只有 main 仍等于测试基准时才推送成功）。' };
}
