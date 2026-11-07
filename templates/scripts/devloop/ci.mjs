/**
 * 触发并等待 CI，返回 { status: 'ok' | 'failed' | 'error', base, url, note }。
 * 任何查询、解析异常都转为 status=error（由 policy 的 CI 重试上限兜底），绝不向外抛。
 * io 可注入，便于在 ci.test.mjs 里模拟 gh 出错、超时等情况。
 */
import { randomBytes } from 'node:crypto';
import { matchPrRun } from './gitops.mjs';

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

export function classify(conclusion) {
  if (conclusion === 'success') return 'ok';
  // timed_out = 任务超过 timeout-minutes，多为测试挂起，属于代码问题
  if (conclusion === 'failure' || conclusion === 'timed_out') return 'failed';
  return 'error';
}

/**
 * io: {
 *   dispatch(inputs)            触发 ci.yml（workflow_dispatch）；不支持时抛出含 “workflow_dispatch” 的错误
 *   listDispatchRuns()          → [{ displayTitle, status, conclusion, url }]
 *   listPrRuns(head)            → GitHub API workflow_runs 数组
 *   sleep(ms), now()
 * }
 */
export async function runCi({ pr, head, base, io, timeoutMs = 30 * 60_000, pollMs = 15_000 }) {
  try {
    const nonce = randomBytes(6).toString('hex');
    try {
      await io.dispatch({ pr, head, base, nonce });
    } catch (e) {
      // main 上的 ci.yml 还不支持 workflow_dispatch（只发生在 devloop 自身合入之前）：
      // 退而使用该 PR 的 pull_request 运行，前提是它测的正是这个 head、且合并基准正是这个 base
      // 要看完整错误（gh 的原因写在 stderr 的后几行，不在第一行）
      if (/workflow_dispatch/.test(`${e?.message ?? e}\n${e?.stderr ?? ''}`)) return await fromPullRequestRun({ pr, head, base, io });
      return { status: 'error', base, url: null, note: `无法触发 CI：${firstLine(e)}` };
    }
    const deadline = io.now() + timeoutMs;
    let run = null;
    while (io.now() < deadline) {
      await io.sleep(pollMs);
      try {
        run = (await io.listDispatchRuns()).find((r) => r.displayTitle.includes(nonce)) ?? run;
      } catch {
        continue; // 单次查询失败：继续轮询，直到超时
      }
      if (run?.status === 'completed') break;
    }
    if (!run || run.status !== 'completed') return { status: 'error', base, url: run?.url ?? null, note: '等待 CI 超时' };
    const status = classify(run.conclusion);
    return { status, base, url: run.url, note: status === 'ok' ? undefined : `CI 结论 ${run.conclusion}` };
  } catch (e) {
    return { status: 'error', base, url: null, note: `CI 查询出错：${firstLine(e)}` };
  }
}

async function fromPullRequestRun({ pr, head, base, io }) {
  try {
    const run = matchPrRun(await io.listPrRuns(head), { pr, head, base });
    if (!run) return { status: 'error', base, url: null, note: '无法触发 dispatch CI，也没有 head 与 base 都吻合的 pull_request CI' };
    const note = '回退：使用该 PR 的 pull_request CI（head 与 base 均已核对）';
    return { status: classify(run.conclusion), base, url: run.html_url, note: `${note}；结论 ${run.conclusion}` };
  } catch (e) {
    return { status: 'error', base, url: null, note: `CI 查询出错：${firstLine(e)}` };
  }
}
