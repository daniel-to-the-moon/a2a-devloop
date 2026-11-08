/**
 * 审核提示词与审核评论的格式（本机审核方 devloop.mjs 与云端审核 cloud.mjs 共用）。
 */
import { marker } from './policy.mjs';

/** 云端审核以 GITHUB_TOKEN 发评论；gh pr view 显示为 github-actions，REST 显示为 github-actions[bot] */
export const CLOUD_REVIEWER_LOGINS = ['github-actions', 'github-actions[bot]'];

/**
 * 按 review-schema.json 校验 GPT 结论（必填字段、类型、枚举、无多余字段）。返回错误说明，合法时返回 ''。
 * 不合法的结论一律按“GPT 审核失败”（基础设施问题）处理，计入同一提交 3 次的停止上限；
 * 否则像 findings 不是数组这类结论会在 decide 里抛错、写不出 retry 标记，定时扫描会无限重审。
 */
export function validateReview(r) {
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const extra = (o, keys) => Object.keys(o).find((k) => !keys.includes(k));
  if (!isObj(r)) return '结论不是对象';
  if (extra(r, ['verdict', 'summary', 'findings'])) return `结论含多余字段 ${extra(r, ['verdict', 'summary', 'findings'])}`;
  if (!['approve', 'request_changes'].includes(r.verdict)) return `verdict 非法：${JSON.stringify(r.verdict)}`;
  if (typeof r.summary !== 'string') return 'summary 不是字符串';
  if (!Array.isArray(r.findings)) return 'findings 不是数组';
  const F = ['severity', 'file', 'line', 'issue', 'suggestion'];
  for (const [i, f] of r.findings.entries()) {
    if (!isObj(f)) return `findings[${i}] 不是对象`;
    if (extra(f, F)) return `findings[${i}] 含多余字段 ${extra(f, F)}`;
    if (!['blocker', 'major', 'minor'].includes(f.severity)) return `findings[${i}].severity 非法：${JSON.stringify(f.severity)}`;
    if (!Number.isInteger(f.line)) return `findings[${i}].line 不是整数`;
    for (const k of ['file', 'issue', 'suggestion']) if (typeof f[k] !== 'string') return `findings[${i}].${k} 不是字符串`;
  }
  return '';
}

export function buildReviewPrompt({ header, pr, meta, base, stat }) {
  return [
    header,
    `\n## 本次 PR\n\n- 编号：#${pr}\n- 标题：${meta.title}\n- 审核提交：${meta.headRefOid}\n- 基准：${meta.baseRefName}（${base}）`,
    `\n### PR 描述（执行者所写，仅供参考，需自行核对）\n\n${meta.body}`,
    `\n### 改动文件\n\n\`\`\`\n${stat}\n\`\`\``,
    `\n用 \`git diff ${base}...HEAD\` 查看完整改动。测试与构建由 CI 在合并后的代码上另行执行，你只需审代码。`,
  ].join('\n');
}

export function formatReview({ key, model, where, pr, head, review, ci, d }) {
  const sev = { blocker: '🛑 blocker', major: '⚠️ major', minor: '💬 minor' };
  const findings = review.findings.length
    ? review.findings.map((f, i) => `${i + 1}. **${sev[f.severity]}** \`${f.file}:${f.line}\`\n   - 问题：${f.issue}\n   - 建议：${f.suggestion}`).join('\n')
    : '无。';
  const ciText = { ok: '✅ 通过', failed: '❌ 失败', error: '⚠️ 未完成' }[ci.status];
  return [
    `执行者：GPT（${model}，${where}；独立于代码执行者 Claude）`,
    '',
    `**结论：${review.verdict === 'approve' ? '✅ 通过' : review.verdict === 'error' ? '⚠️ 审核未完成' : '🔁 需修改'}**（审核提交 \`${head.slice(0, 8)}\`）`,
    '',
    review.summary,
    '',
    `### 测试与构建（GitHub Actions，PR 合并到 main \`${ci.base.slice(0, 8)}\` 之后的代码）`,
    `${ciText}${ci.url ? `：${ci.url}` : ''}${ci.note ? `（${ci.note}）` : ''}`,
    '',
    '### 审核意见',
    findings,
    '',
    '### 流水线动作',
    d.text,
    '',
    marker(key, { pr, state: d.state, reason: d.reason, head, base: ci.base }),
  ].join('\n');
}

/**
 * PR 是否改动工作流文件：GITHUB_TOKEN 无 workflows 权限，这类 PR 云端合并不了，交给本机审核方。
 * paths 须含重命名前后两个路径（prstate 从 REST 取 filename + previous_filename），移入、移出、删除都算。
 */
export function touchesWorkflows(paths) {
  return paths.some((p) => String(p).replace(/^\.\//, '').startsWith('.github/workflows/'));
}

/**
 * auto 模式轮次用满合并后，剩余意见逐条转成 devloop issue（格式见 docs/DEVLOOP.md 四、issue 格式）。
 * 返回 [{ title, body }]；标题截断到 120 字。
 */
export function followUpIssues({ pr, head, findings }) {
  const sevText = { blocker: 'blocker', major: 'major', minor: 'minor' };
  return findings.map((f) => {
    const oneLine = String(f.issue).replace(/\s+/g, ' ').trim();
    const title = `[#${pr} 遗留·${sevText[f.severity]}] ${oneLine}`.slice(0, 120);
    const body = [
      `来源：PR #${pr} 轮次用满后按 auto 模式合并（审核提交 \`${String(head).slice(0, 8)}\`），GPT 最后一轮的遗留意见。`,
      '',
      '## 现象',
      '',
      `\`${f.file}:${f.line}\`（${sevText[f.severity]}）`,
      '',
      f.issue,
      '',
      '## 建议',
      '',
      f.suggestion,
      '',
      '## 验收标准',
      '',
      '- [ ] 上述问题在 main 上不再成立，或说明为何不成立',
      '- [ ] 为修复补充回归测试',
    ].join('\n');
    return { title, body };
  });
}
