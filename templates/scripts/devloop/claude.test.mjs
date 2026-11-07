// claude.yml 用到的 ctx.sh / publish.sh 的行为测试：假 gh（记录调用、返回预设值）+ 真 git（本地临时远端）
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'devloop-claude-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** 造一个假 gh：把参数逐行记到 log；`gh pr view` 输出 FAKE_HEAD_REF */
function fakeGh(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash\necho "$*" >> "${join(dir, 'gh.log')}"\nif [ "$1 $2" = "pr view" ]; then printf '%s' "$FAKE_HEAD_REF"; fi\nexit "\${FAKE_GH_EXIT:-0}"\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { path: `${bin}:${process.env.PATH}`, log: () => { try { return readFileSync(join(dir, 'gh.log'), 'utf8'); } catch { return ''; } } };
}

function runCtx(env) {
  const dir = join(root, `ctx-${n++}`);
  mkdirSync(dir);
  const gh = fakeGh(dir);
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', [join(HERE, 'ctx.sh')], { env: { ...process.env, PATH: gh.path, GITHUB_OUTPUT: out, REPO: 'o/r', ...env }, encoding: 'utf8' });
  const kv = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('=')));
  return { code: r.status, kv, stderr: r.stderr };
}

test('ctx：issue 事件 → implement，分支 claude/issue-N', () => {
  const r = runCtx({ EVENT: 'issues', N: '12' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.kv, { mode: 'implement', branch: 'claude/issue-12', number: '12' });
});

test('ctx：评论与手动触发 → fix，只接受 claude/* 分支；非 claude/* 或跨仓库（空）拒绝', () => {
  for (const EVENT of ['issue_comment', 'workflow_dispatch']) {
    assert.deepEqual(runCtx({ EVENT, N: '4', FAKE_HEAD_REF: 'claude/m1-prototype' }).kv, { mode: 'fix', branch: 'claude/m1-prototype', number: '4' });
    assert.notEqual(runCtx({ EVENT, N: '4', FAKE_HEAD_REF: 'main' }).code, 0);
    assert.notEqual(runCtx({ EVENT, N: '4', FAKE_HEAD_REF: '' }).code, 0);
  }
});

test('ctx：编号必须是纯数字（防注入）', () => {
  for (const N of ['', '4; rm -rf /', '4a', '-1', '$(id)']) assert.notEqual(runCtx({ EVENT: 'workflow_dispatch', N, FAKE_HEAD_REF: 'claude/x' }).code, 0, N);
});

/** publish 环境：本地临时远端（main 一个提交 + claude 分支），work 产物里一个新提交的 bundle */
function publishSetup({ outcome = 'pr', branch = 'claude/x', withBundle = true } = {}) {
  const dir = join(root, `pub-${n++}`);
  mkdirSync(dir);
  const remote = join(dir, 'remote.git');
  const g = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const wc = join(dir, 'wc');
  execFileSync('git', ['clone', '-q', remote, wc]);
  writeFileSync(join(wc, 'a'), '1');
  g(['add', 'a'], wc);
  g(['commit', '-q', '-m', 'base'], wc);
  g(['push', '-q', 'origin', `HEAD:refs/heads/main`], wc);
  g(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], wc);
  const start = g(['rev-parse', 'HEAD'], wc);
  writeFileSync(join(wc, 'b'), '2');
  g(['add', 'b'], wc);
  g(['commit', '-q', '-m', 'work'], wc);
  const out = join(dir, 'out');
  mkdirSync(out);
  if (outcome !== null) writeFileSync(join(out, 'outcome'), `${outcome}\n`);
  writeFileSync(join(out, 'body.md'), '执行者：Claude（devloop）\n\n说明');
  writeFileSync(join(out, 'title.txt'), '标题');
  if (withBundle) g(['bundle', 'create', join(out, 'work.bundle'), `${start}..HEAD`, 'HEAD'], wc);
  const newSha = g(['rev-parse', 'HEAD'], wc);
  const gh = fakeGh(dir);
  const run = (env) =>
    spawnSync('bash', [join(HERE, 'publish.sh')], {
      env: { ...process.env, PATH: gh.path, OUT: out, REPO: 'o/r', N: '4', START: start, BRANCH: branch, PUSH_URL: remote, RUN_URL: 'https://run', ...env },
      encoding: 'utf8',
    });
  return { run, gh, remote, start, newSha, ref: (r) => execFileSync('git', ['rev-parse', r], { cwd: remote, encoding: 'utf8' }).trim() };
}

test('publish：fix 推送到分支并评论；评论触发不动标签', () => {
  const t = publishSetup();
  const r = t.run({ MODE: 'fix', EVENT: 'issue_comment' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.ref('refs/heads/claude/x'), t.newSha);
  assert.match(t.gh.log(), /^pr comment 4/m);
  assert.doesNotMatch(t.gh.log(), /remove-label/);
});

test('publish：手动重跑成功后只移除 needs-user（不动 hold）', () => {
  const t = publishSetup();
  const r = t.run({ MODE: 'fix', EVENT: 'workflow_dispatch' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.gh.log(), /^pr edit 4 -R o\/r --remove-label needs-user$/m);
  assert.doesNotMatch(t.gh.log(), /hold/);
});

test('publish：implement 推送并开 PR，编号与分支正确传递', () => {
  const t = publishSetup({ branch: 'claude/issue-4' });
  const r = t.run({ MODE: 'implement', EVENT: 'issues' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.ref('refs/heads/claude/issue-4'), t.newSha);
  assert.match(t.gh.log(), /^pr create -R o\/r --base main --head claude\/issue-4 --title 标题/m);
});

test('publish：outcome 为 needs-user 或产物缺失 → 评论 + 加 needs-user，不推送', () => {
  for (const outcome of ['needs-user', null]) {
    const t = publishSetup({ outcome, withBundle: false });
    const r = t.run({ MODE: 'fix', EVENT: 'issue_comment' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(t.gh.log(), /^issue edit 4 -R o\/r --add-label needs-user$/m);
    assert.equal(t.ref('refs/heads/claude/x'), t.start);
  }
});

test('publish：拒绝推送到非 claude/* 分支；分支已被别人更新（非快进）时失败、不覆盖', () => {
  const bad = publishSetup({ branch: 'main' });
  assert.notEqual(bad.run({ MODE: 'fix', EVENT: 'issue_comment' }).status, 0);
  assert.equal(bad.ref('refs/heads/main'), bad.start);

  const t = publishSetup();
  // 别人先往分支推了一个不同的提交
  const other = join(root, `other-${n++}`);
  execFileSync('git', ['clone', '-q', '-b', 'claude/x', t.remote, other]);
  writeFileSync(join(other, 'c'), '3');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'x', '--allow-empty'], { cwd: other });
  execFileSync('git', ['-C', other, 'add', 'c']);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'other'], { cwd: other });
  execFileSync('git', ['push', '-q', 'origin', 'claude/x'], { cwd: other });
  const theirs = t.ref('refs/heads/claude/x');
  assert.notEqual(t.run({ MODE: 'fix', EVENT: 'issue_comment' }).status, 0);
  assert.equal(t.ref('refs/heads/claude/x'), theirs);
});
