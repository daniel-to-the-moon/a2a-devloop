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
 * comments: [{ author, body }]；reviewer：审核方 GitHub 账号。
 * 返回有效标记（签名正确、作者是审核方、评论以审核前缀开头、PR 号一致），每条评论至多一个。
 */
export function parseMarkers(comments, { key, reviewer, pr }) {
  const out = [];
  for (const c of comments) {
    if (c.author !== reviewer || !c.body.startsWith(REVIEW_PREFIX)) continue;
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
export function roundsUsed(markers) {
  return new Set(markers.filter((m) => m.state === 'changes').map((m) => m.head)).size;
}

export function isBlocking(findings) {
  return findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
}

/**
 * 合并前的最终决定。
 * ci: { status: 'ok' | 'failed' | 'error', base }，base 为 CI 实际测试的基准提交
 * now: { labels, base, mergeable, state, isDraft, baseRefName }：决定前一刻重新读取的 PR 状态与 main
 */
export function decide({ ci, review, now, roundsBefore, allowMerge, retriesForHead = 0 }) {
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
    if (round >= MAX_ROUNDS) {
      return { state: 'stopped', merge: false, addLabel: 'needs-user', text: `已连续 ${round} 轮未通过，达到上限 ${MAX_ROUNDS}，停止自动循环，请用户裁决（已加 needs-user 标签）。` };
    }
    const why = [
      ci.status === 'failed' ? '测试或构建失败' : null,
      !approved ? 'GPT 要求修改' : null,
      now.mergeable === 'CONFLICTING' ? '与基准分支冲突（先 git merge origin/main）' : null,
    ].filter(Boolean);
    return { state: 'changes', merge: false, text: `第 ${round} 轮未通过：${why.join('；')}。执行者修复后自动重新审核。` };
  }
  if (!allowMerge) return { state: 'retry', merge: false, text: '审核通过（本次指定 --no-merge，未合并）。' };
  if (ci.base !== now.base) return { state: 'retry', merge: false, text: '测试之后 main 有了新提交，测试结果不再代表合并后的代码，下一轮用新 main 重新审核与测试。' };
  return { state: 'merged', merge: true, text: '审核通过 + 合并后代码测试通过 → 合并（只有 main 仍等于测试基准时才推送成功）。' };
}
