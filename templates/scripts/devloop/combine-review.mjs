/**
 * 双评审合并：
 * 云端审核在 GPT 之外再让 Claude 独立审一遍，两份结论合成一份交给 decide。
 *
 * - 任一方 request_changes → 合并结论为 request_changes；两方都 approve 才 approve。
 * - 意见逐条保留，问题前加 [GPT] / [Claude] 标明来源；摘要两段并列。
 * - 合并结果仍符合 review-schema.json，decide（cloud.mjs）与签名标记逻辑不需要改。
 * - Claude 结论缺失或不合法时退出码非 0，review 任务失败，decide 按“审核未完成”（基础设施问题）处理，
 *   计入同一提交 3 次的停止上限；不会退化成只有 GPT 一方就放行。
 *
 * 用法：
 *   node combine-review.mjs prompt --in prompt.md --ctx <预生成 diff 的目录> --out claude-prompt.md
 *   node combine-review.mjs merge --gpt review.json --claude claude-result.json --out combined.json
 *   node combine-review.mjs solo --claude claude-result.json --out review.json   （作者是 GPT 的 PR：Claude 是唯一审核方）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { validateReview } from './review-format.mjs';

/**
 * 把 GPT 的审核提示词改成第二审核方 Claude 的身份；必查项、严重度、输出格式完全相同。
 * Claude 没有 Bash（前缀白名单挡不住 `git log --output` 写文件），
 * 所以“用 git diff 查看”那一行换成工作流预先生成的只读文件路径。
 */
export function claudePrompt(gptPrompt, ctxDir, { author = 'claude' } = {}) {
  if (!ctxDir) throw new Error('缺少预生成 diff 的目录');
  const lines = gptPrompt.split('\n');
  const first = lines[0] ?? '';
  if (!first.includes('审核方 GPT')) throw new Error('审核提示词首行格式变了，找不到“审核方 GPT”');
  lines[0] = first.replace('审核方 GPT', '第二审核方 Claude（只读评审会话）');
  const i = lines.findIndex((l) => l.startsWith('用 `git diff '));
  if (i < 0) throw new Error('审核提示词里找不到“用 `git diff …` 查看完整改动”这一行');
  lines[i] = `完整改动已预先生成：\`${ctxDir}/diff.patch\`（统计 \`${ctxDir}/stat.txt\`，提交记录 \`${ctxDir}/log.txt\`），用 Read / Grep 阅读；当前工作目录是 PR 头部提交的检出。测试与构建由 CI 在合并后的代码上另行执行，你只需审代码。`;
  if (author === 'gpt') lines[0] = lines[0].replace('第二审核方 Claude（只读评审会话）', '审核方 Claude（只读评审会话；本 PR 由 GPT 编写，GPT 不审自己的代码，你是唯一的代码审核方）');
  return [
    lines.join('\n'),
    '',
    author === 'gpt' ? '## 审核方补充说明' : '## 第二审核方补充说明',
    '',
    ...(author === 'gpt'
      ? ['- 本 PR 的代码作者是 GPT（Codex）。你是唯一的代码审核方：你 approve 且 CI 通过就会合并，按最严标准审。']
      : ['- 你与第一审核方 GPT 并行、互不可见，结论会合并：任一方 request_changes 就不会合并。',
        '- 代码执行者也是 Claude，但是另一个会话；你与它独立，不要因为同属一家模型就放松标准。']),
    '- 你只有 Read / Glob / Grep 三个工具，不能运行命令；不要尝试修改任何文件。',
    '- 额外核对“验收”：PR 描述与关联 issue 里的验收标准是否逐条有代码与测试对应；缺了就列为 major。',
    '- 只输出符合给定 JSON Schema 的结论。',
  ].join('\n');
}

/** 从 `claude -p --output-format json --json-schema …` 的输出里取结构化结论。 */
export function extractClaude(raw) {
  let out;
  try {
    out = JSON.parse(raw);
  } catch {
    throw new Error('Claude 输出不是 JSON');
  }
  if (!out || typeof out !== 'object') throw new Error('Claude 输出不是对象');
  if (out.is_error || out.subtype !== 'success') throw new Error(`Claude 审核未成功：${out.subtype ?? '未知'}${out.result ? `（${String(out.result).slice(0, 200)}）` : ''}`);
  let review = out.structured_output;
  if (review === undefined && typeof out.result === 'string') {
    try {
      review = JSON.parse(out.result);
    } catch {
      throw new Error('Claude 没有给出结构化结论');
    }
  }
  const bad = validateReview(review);
  if (bad) throw new Error(`Claude 结论不合法：${bad}`);
  return review;
}

/** 作者是 GPT 的 PR：只有 Claude 一方的结论（意见同样标 [Claude]，格式与合并结果一致） */
export function soloClaude(claude) {
  const bad = validateReview(claude);
  if (bad) throw new Error(`Claude 结论不合法：${bad}`);
  return {
    verdict: claude.verdict,
    summary: `Claude（${claude.verdict === 'approve' ? '通过' : '需修改'}；作者是 GPT，GPT 不参与审核）：${claude.summary}`,
    findings: claude.findings.map((f) => ({ ...f, issue: `[Claude] ${f.issue}` })),
  };
}

export function combineReviews(gpt, claude) {
  for (const [who, r] of [['GPT', gpt], ['Claude', claude]]) {
    const bad = validateReview(r);
    if (bad) throw new Error(`${who} 结论不合法：${bad}`);
  }
  const tag = (who) => (f) => ({ ...f, issue: `[${who}] ${f.issue}` });
  const label = (r) => (r.verdict === 'approve' ? '通过' : '需修改');
  return {
    verdict: gpt.verdict === 'approve' && claude.verdict === 'approve' ? 'approve' : 'request_changes',
    summary: `GPT（${label(gpt)}）：${gpt.summary}\n\nClaude（${label(claude)}）：${claude.summary}`,
    findings: [...gpt.findings.map(tag('GPT')), ...claude.findings.map(tag('Claude'))],
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`缺少参数 --${name}`);
  return process.argv[i + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const cmd = process.argv[2];
    if (cmd === 'prompt') {
      const ai = process.argv.indexOf('--author');
      writeFileSync(arg('out'), claudePrompt(readFileSync(arg('in'), 'utf8'), arg('ctx'), { author: ai > 0 ? process.argv[ai + 1] : 'claude' }));
    } else if (cmd === 'solo') {
      const review = soloClaude(extractClaude(readFileSync(arg('claude'), 'utf8')));
      writeFileSync(arg('out'), JSON.stringify(review, null, 2));
      console.log(`Claude（唯一审核方）：${review.verdict}（意见 ${review.findings.length} 条）`);
    } else if (cmd === 'merge') {
      const gpt = JSON.parse(readFileSync(arg('gpt'), 'utf8'));
      const claude = extractClaude(readFileSync(arg('claude'), 'utf8'));
      const merged = combineReviews(gpt, claude);
      writeFileSync(arg('out'), JSON.stringify(merged, null, 2));
      console.log(`GPT：${gpt.verdict}，Claude：${claude.verdict} → ${merged.verdict}（意见 ${merged.findings.length} 条）`);
    } else {
      throw new Error(`未知子命令：${cmd}`);
    }
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
