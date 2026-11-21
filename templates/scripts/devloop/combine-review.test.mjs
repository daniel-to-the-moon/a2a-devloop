import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claudePrompt, combineReviews, extractClaude } from './combine-review.mjs';
import { buildReviewPrompt, validateReview } from './review-format.mjs';

const approve = { verdict: 'approve', summary: '没问题', findings: [] };
const minor = { severity: 'minor', file: 'a.ts', line: 3, issue: '命名', suggestion: '改名' };
const major = { severity: 'major', file: 'b.ts', line: 9, issue: '缺测试', suggestion: '补测试' };

test('combineReviews：两方都通过才通过', () => {
  assert.equal(combineReviews(approve, approve).verdict, 'approve');
  const withMinor = { ...approve, findings: [minor] };
  assert.equal(combineReviews(withMinor, approve).verdict, 'approve');
});

test('combineReviews：任一方需修改即需修改，意见带来源', () => {
  const rc = { verdict: 'request_changes', summary: '缺测试', findings: [major] };
  for (const [g, c] of [[rc, approve], [approve, rc], [rc, rc]]) {
    const m = combineReviews(g, c);
    assert.equal(m.verdict, 'request_changes');
    assert.equal(validateReview(m), '');
  }
  const m = combineReviews({ ...approve, findings: [minor] }, rc);
  assert.deepEqual(m.findings.map((f) => f.issue), ['[GPT] 命名', '[Claude] 缺测试']);
  assert.match(m.summary, /^GPT（通过）：没问题\n\nClaude（需修改）：缺测试$/);
});

test('combineReviews：不合法的结论直接抛错，不会被当成通过', () => {
  assert.throws(() => combineReviews(approve, { verdict: 'approve', summary: 'x' }), /Claude 结论不合法/);
  assert.throws(() => combineReviews({ verdict: 'lgtm', summary: '', findings: [] }, approve), /GPT 结论不合法/);
});

test('extractClaude：取 structured_output；失败、缺失、不合法都抛错', () => {
  const ok = { type: 'result', subtype: 'success', is_error: false, structured_output: approve };
  assert.deepEqual(extractClaude(JSON.stringify(ok)), approve);
  // 没有 structured_output 时退回解析 result 文本
  assert.deepEqual(extractClaude(JSON.stringify({ subtype: 'success', result: JSON.stringify(approve) })), approve);
  assert.throws(() => extractClaude('not json'), /不是 JSON/);
  assert.throws(() => extractClaude(JSON.stringify({ subtype: 'error_max_turns', is_error: true })), /未成功：error_max_turns/);
  assert.throws(() => extractClaude(JSON.stringify({ subtype: 'success', result: '我觉得可以' })), /没有给出结构化结论/);
  assert.throws(() => extractClaude(JSON.stringify({ subtype: 'success', structured_output: { verdict: 'approve' } })), /不合法/);
});

const realPrompt = () =>
  buildReviewPrompt({
    header: readFileSync(new URL('./review-prompt.md', import.meta.url), 'utf8'),
    pr: 63,
    meta: { title: 't', headRefOid: 'h'.repeat(40), baseRefName: 'main', body: 'b' },
    base: 'b'.repeat(40),
    stat: ' a | 1 +',
  });

test('claudePrompt：基于真实的审核提示词改身份，保留全部必查项，diff 改为预生成文件', () => {
  const gpt = realPrompt();
  const p = claudePrompt(gpt, '/tmp/ctx');
  assert.match(p.split('\n')[0], /第二审核方 Claude/);
  assert.ok(!p.split('\n')[0].includes('审核方 GPT'));
  assert.ok(!p.includes('用 `git diff '), '不应再让 Claude 运行 git diff');
  assert.match(p, /\/tmp\/ctx\/diff\.patch/);
  for (const line of gpt.split('\n').slice(1)) if (!line.startsWith('用 `git diff ')) assert.ok(p.includes(line), `缺少：${line}`);
  assert.match(p, /验收标准/);
  assert.throws(() => claudePrompt('别的格式', '/tmp/ctx'), /找不到/);
  assert.throws(() => claudePrompt(gpt), /缺少/);
});

// 安全回归：Claude 审核步骤不得拿到任何能写文件或执行命令的工具，
// 也不得加载 PR 里的设置与 MCP。`Bash(git log:*)` 之类的前缀白名单可经 `git log --output=…` 写文件。
test('gpt-review.yml：Claude 审核只给 Read/Glob/Grep，禁用 Bash 与写工具，不加载 PR 设置', () => {
  const yml = readFileSync(new URL('../../.github/workflows/gpt-review.yml', import.meta.url), 'utf8');
  const step = yml.slice(yml.indexOf('- name: Claude 审核'), yml.indexOf('- name: 合并两方结论'));
  assert.ok(step.includes('claude -p'), '找不到 Claude 审核步骤');
  const allowed = /--allowedTools "([^"]*)"/.exec(step)?.[1];
  assert.equal(allowed, 'Read,Glob,Grep');
  const disallowed = (/--disallowedTools "([^"]*)"/.exec(step)?.[1] ?? '').split(',');
  for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']) assert.ok(disallowed.includes(t), `未禁用 ${t}`);
  assert.match(step, /--setting-sources user\b/);
  assert.match(step, /--strict-mcp-config\b/);
  assert.ok(!/--dangerously|bypassPermissions|--permission-mode/.test(step), '不得放宽权限模式');
  // diff 在启动 Claude 之前由工作流生成
  assert.ok(step.indexOf('diff.patch') < step.indexOf('claude -p'));
});
