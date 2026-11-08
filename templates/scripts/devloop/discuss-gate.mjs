#!/usr/bin/env node
/**
 * gpt-discuss.yml 的触发判定：这次事件要不要让 GPT 在讨论 issue 下发言。由 discuss-gate.test.mjs 覆盖。
 *
 * 规则（控制费用：只在明确时机发言，不是每条评论都跑）：
 * - issue 被打上 discussion / proposal 标签 → 首次评审（mode=first）。带标签新建 issue 时 GitHub 也会为每个标签发
 *   labeled 事件，所以不再处理 opened（否则同一次创建会发言两次）；多个 labeled 事件由 discuss-build.mjs 去重。
 * - 在带这两个标签的 issue（不是 PR）下评论里写 @gpt → 回答这条评论（mode=mention，带评论 id）；机器人、GPT 自己的评论不触发
 * - 手动触发（workflow_dispatch，输入 issue 编号）→ mode=manual
 *
 * 用法：node discuss-gate.mjs <事件名> <事件 JSON 路径>；结果写到 $GITHUB_OUTPUT（run=true|false、issue=<编号>、reason=…）
 */
import { appendFileSync, readFileSync } from 'node:fs';

export const DISCUSS_LABELS = ['discussion', 'proposal'];
const hasDiscussLabel = (issue) => (issue?.labels ?? []).some((l) => DISCUSS_LABELS.includes(typeof l === 'string' ? l : l.name));

export function gate(eventName, event) {
  const no = (reason) => ({ run: false, issue: null, mode: null, comment: null, reason });
  const yes = (issue, mode, reason, comment = null) => ({ run: true, issue, mode, comment, reason });
  if (eventName === 'workflow_dispatch') {
    const n = String(event?.inputs?.issue ?? '');
    return /^[1-9]\d*$/.test(n) ? yes(Number(n), 'manual', '手动触发') : no(`编号无效：${n}`);
  }
  const issue = event?.issue;
  if (!issue || issue.pull_request) return no('不是 issue');
  if (eventName === 'issues') {
    if (event.action === 'labeled') {
      return DISCUSS_LABELS.includes(event.label?.name) ? yes(issue.number, 'first', `打上 ${event.label.name} 标签`) : no('打的不是讨论标签');
    }
    return no(`不处理 issues.${event.action}`);
  }
  if (eventName === 'issue_comment') {
    if (event.action !== 'created') return no('不是新评论');
    if (!hasDiscussLabel(issue)) return no('issue 不带讨论标签');
    const c = event.comment ?? {};
    if (c.user?.type === 'Bot' || /\[bot\]$/.test(c.user?.login ?? '')) return no('机器人评论');
    const body = String(c.body ?? '');
    if (body.startsWith('执行者：GPT')) return no('GPT 自己的评论');
    return /(^|[^\w@])@gpt\b/i.test(body) ? yes(issue.number, 'mention', '评论里点名 @gpt', c.id ?? null) : no('评论未点名 @gpt');
  }
  return no(`不处理事件 ${eventName}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [eventName, path] = process.argv.slice(2);
  const r = gate(eventName, JSON.parse(readFileSync(path, 'utf8')));
  const out = `run=${r.run}\nissue=${r.issue ?? ''}\nmode=${r.mode ?? ''}\ncomment=${r.comment ?? ''}\nreason=${r.reason}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
  process.stdout.write(out);
}
