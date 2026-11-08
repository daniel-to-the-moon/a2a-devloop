import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gate } from './discuss-gate.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const issue = (labels, extra = {}) => ({ number: 3, labels: labels.map((name) => ({ name })), ...extra });
const comment = (body, user = { login: 'someone', type: 'User' }) => ({ body, user });

test('新建 issue 不直接发言（带标签新建会另有 labeled 事件，避免同一次创建发言两次）', () => {
  assert.equal(gate('issues', { action: 'opened', issue: issue(['discussion']) }).run, false);
  assert.equal(gate('issues', { action: 'opened', issue: issue(['bug']) }).run, false);
});

test('打标签：只有打的是讨论标签才发言（打别的标签不重复发言）', () => {
  assert.equal(gate('issues', { action: 'labeled', label: { name: 'discussion' }, issue: issue(['discussion']) }).mode, 'first');
  assert.equal(gate('issues', { action: 'labeled', label: { name: 'devloop' }, issue: issue(['proposal', 'devloop']) }).run, false);
  assert.equal(gate('issues', { action: 'edited', issue: issue(['discussion']) }).run, false);
});

test('评论：讨论 issue 下点名 @gpt 才发言；机器人、GPT 自己、PR、未点名都不发言', () => {
  const ev = (body, extra = {}) => ({ action: 'created', issue: issue(['discussion']), comment: comment(body), ...extra });
  const m = gate('issue_comment', { ...ev('@gpt 请复核第三点'), comment: { ...comment('@gpt 请复核第三点'), id: 991 } });
  assert.equal(m.mode, 'mention');
  assert.equal(m.comment, 991);
  assert.equal(gate('issue_comment', ev('请 @GPT 看一下')).run, true);
  assert.equal(gate('issue_comment', ev('普通讨论，没有点名')).run, false);
  assert.equal(gate('issue_comment', ev('邮件 a@gpt.com')).run, false); // 邮箱里的 @gpt 不算
  assert.equal(gate('issue_comment', ev('执行者：GPT（云端）\n… @gpt')).run, false);
  assert.equal(gate('issue_comment', { ...ev('@gpt'), comment: comment('@gpt', { login: 'github-actions[bot]', type: 'Bot' }) }).run, false);
  assert.equal(gate('issue_comment', { ...ev('@gpt'), issue: issue(['bug']) }).run, false);
  assert.equal(gate('issue_comment', { ...ev('@gpt'), issue: issue(['discussion'], { pull_request: {} }) }).run, false);
  assert.equal(gate('issue_comment', { ...ev('@gpt'), action: 'edited' }).run, false);
});

test('手动触发：编号必须是正整数', () => {
  assert.deepEqual(gate('workflow_dispatch', { inputs: { issue: '3' } }), { run: true, issue: 3, mode: 'manual', comment: null, reason: '手动触发' });
  for (const bad of ['', '0', '-1', '3; rm -rf /', 'abc']) assert.equal(gate('workflow_dispatch', { inputs: { issue: bad } }).run, false, bad);
});

test('命令行：写入 GITHUB_OUTPUT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const ev = join(dir, 'ev.json');
    const out = join(dir, 'out');
    writeFileSync(ev, JSON.stringify({ action: 'labeled', label: { name: 'proposal' }, issue: issue(['proposal']) }));
    writeFileSync(out, '');
    execFileSync(process.execPath, [join(HERE, 'discuss-gate.mjs'), 'issues', ev], { env: { ...process.env, GITHUB_OUTPUT: out } });
    assert.match(readFileSync(out, 'utf8'), /^run=true\nissue=3\nmode=first\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gpt-discuss.yml：评审任务只读、发评论任务不跑模型，并调用 discuss-gate.mjs', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/gpt-discuss.yml'), 'utf8');
  const job = (name) => yml.match(new RegExp(`^  ${name}:\\n((?:(?: {4,}.*)?\\n)*)`, 'm'))?.[1] ?? '';
  const review = job('review');
  const post = job('post');
  assert.ok(review && post, '缺少 review 或 post 任务');
  assert.match(review, /^ {6}contents: read$/m);
  assert.match(review, /^ {6}issues: read$/m);
  assert.doesNotMatch(review, /: write$/m);
  assert.match(review, /permission-profile: ':read-only'/);
  assert.match(review, /node scripts\/devloop\/discuss-gate\.mjs/);
  assert.match(review, /uses: openai\/codex-action@bdf19a4a223ec2549a3e2274a0cf61556bc07675 /); // 固定为 v1.13 指向的提交
  // 整次运行按 issue 串行、保留全部排队：重复的首次评审被去重，@gpt 点名不被挤掉
  assert.match(yml, /^concurrency:\n {2}group: gpt-discuss-\$\{\{ github\.event\.issue\.number \|\| inputs\.issue \}\}\n {2}cancel-in-progress: false\n {2}queue: max$/m);
  assert.match(yml, /^ {2}issues:\n {4}types: \[labeled\]$/m); // 不处理 opened
  assert.match(review, /node scripts\/devloop\/discuss-build\.mjs/);
  assert.match(review, /responses-api-endpoint: \$\{\{ vars\.GPT_RESPONSES_ENDPOINT \}\}/);
  assert.match(post, /^ {6}issues: write$/m);
  assert.doesNotMatch(post, /uses: openai\/codex-action/);
});
