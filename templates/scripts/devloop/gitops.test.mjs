// 集成测试：在临时目录里建真实的 git 远端与克隆，验证合并 / 推送 / 删分支的实际行为
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { acquireLock, git, matchPrRun, mergeAndPush, reviewCacheKey } from './gitops.mjs';

const root = mkdtempSync(join(tmpdir(), 'devloop-gitops-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function setup() {
  const dir = join(root, `case-${n++}`);
  const remote = `${dir}-remote.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, dir]);
  const g = (args) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], dir);
  const commit = (file, msg) => {
    writeFileSync(join(dir, file), msg);
    g(['add', file]);
    g(['commit', '-q', '-m', msg]);
    return g(['rev-parse', 'HEAD']);
  };
  g(['checkout', '-q', '-b', 'main']);
  const base = commit('a.txt', 'base');
  g(['push', '-q', 'origin', 'main']);
  g(['checkout', '-q', '-b', 'feature']);
  const head = commit('b.txt', 'feature');
  g(['push', '-q', 'origin', 'feature']);
  g(['checkout', '-q', 'main']);
  const remoteRef = (ref) => git(['rev-parse', ref], remote);
  return { dir, remote, g, commit, base, head, remoteRef, home: join(dir, '..', `home-${n}`) };
}

test('main 未变：推送成功，main 的两个父提交正是测试过的 base 与 head；分支被删除', () => {
  const t = setup();
  const { sha, branchDeleted } = mergeAndPush({ repoDir: t.dir, home: t.home, base: t.base, head: t.head, message: 'm', branch: 'feature' });
  assert.equal(t.remoteRef('main'), sha);
  assert.equal(t.remoteRef(`${sha}^1`), t.base);
  assert.equal(t.remoteRef(`${sha}^2`), t.head);
  assert.equal(branchDeleted, true);
  assert.throws(() => t.remoteRef('refs/heads/feature'));
});

test('测试之后 main 有了新提交：推送被拒，main 不变', () => {
  const t = setup();
  const moved = t.commit('c.txt', 'someone else');
  t.g(['push', '-q', 'origin', 'main']);
  assert.throws(() => mergeAndPush({ repoDir: t.dir, home: t.home, base: t.base, head: t.head, message: 'm', branch: 'feature' }));
  assert.equal(t.remoteRef('main'), moved);
  assert.equal(t.remoteRef('refs/heads/feature'), t.head);
});

test('合并后分支上有新提交：分支保留（租约不符）', () => {
  const t = setup();
  t.g(['checkout', '-q', 'feature']);
  const newer = t.commit('d.txt', 'pushed later');
  t.g(['push', '-q', 'origin', 'feature']);
  t.g(['checkout', '-q', 'main']);
  t.g(['fetch', '-q', 'origin']);
  const { branchDeleted } = mergeAndPush({ repoDir: t.dir, home: t.home, base: t.base, head: t.head, message: 'm', branch: 'feature' });
  assert.equal(branchDeleted, false);
  assert.equal(t.remoteRef('refs/heads/feature'), newer);
});

test('beforePush 抛异常（如 PR 已关闭）：不推送', () => {
  const t = setup();
  assert.throws(() =>
    mergeAndPush({
      repoDir: t.dir, home: t.home, base: t.base, head: t.head, message: 'm', branch: 'feature',
      beforePush: () => {
        throw new Error('PR 已关闭');
      },
    }),
  );
  assert.equal(t.remoteRef('main'), t.base);
});

test('matchPrRun：只接受 head 与 base 都吻合、已完成的 ci.yml 运行', () => {
  const run = (o) => ({ path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', pull_requests: [{ number: 6, head: { sha: 'h' }, base: { sha: 'b' } }], ...o });
  const q = { pr: 6, head: 'h', base: 'b' };
  assert.ok(matchPrRun([run()], q));
  assert.equal(matchPrRun([run({ status: 'in_progress' })], q), null);
  assert.equal(matchPrRun([run({ path: '.github/workflows/claude.yml' })], q), null);
  assert.equal(matchPrRun([run({ pull_requests: [{ number: 6, head: { sha: 'h' }, base: { sha: 'old' } }] })], q), null);
  assert.equal(matchPrRun([run({ pull_requests: [{ number: 7, head: { sha: 'h' }, base: { sha: 'b' } }] })], q), null);
});

test('审核缓存键随 head 或 base 变化', () => {
  assert.notEqual(reviewCacheKey(6, 'h1', 'b'), reviewCacheKey(6, 'h2', 'b'));
  assert.notEqual(reviewCacheKey(6, 'h', 'b1'), reviewCacheKey(6, 'h', 'b2'));
});

test('进程锁：同时只有一个持有者；8 个进程并发抢锁不重叠；持有进程崩溃后自动释放', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const lib = JSON.stringify(new URL('./gitops.mjs', import.meta.url).href);
  const release = await acquireLock(port);
  assert.ok(release);
  assert.equal(await acquireLock(port), null);
  const other = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${lib}; process.exit((await acquireLock(${port})) ? 0 : 3);`]);
  assert.equal(await new Promise((r) => other.on('exit', r)), 3);
  await release();

  const events = join(root, 'lock-events');
  const script = `import { acquireLock } from ${lib}; import { appendFileSync } from 'node:fs';
    for (let i = 0; i < 40; i++) {
      const r = await acquireLock(${port});
      if (r) { appendFileSync(${JSON.stringify(events)}, 'in ' + process.hrtime.bigint() + '\\n'); await new Promise((x) => setTimeout(x, 30)); appendFileSync(${JSON.stringify(events)}, 'out ' + process.hrtime.bigint() + '\\n'); await r(); }
      await new Promise((x) => setTimeout(x, 5));
    }`;
  const kids = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', script]));
  await Promise.all(kids.map((k) => new Promise((r) => k.on('exit', r))));
  const lines = readFileSync(events, 'utf8').trim().split('\n').map((l) => l.split(' ')).sort((a, b) => (BigInt(a[1]) < BigInt(b[1]) ? -1 : 1));
  let depth = 0;
  let maxDepth = 0;
  for (const [kind] of lines) {
    depth += kind === 'in' ? 1 : -1;
    maxDepth = Math.max(maxDepth, depth);
  }
  assert.ok(lines.length >= 2);
  assert.equal(maxDepth, 1);

  // 持锁进程被强杀：锁随进程消失
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${lib}; await acquireLock(${port}); console.log('held'); setInterval(() => {}, 1000);`]);
  await new Promise((r) => holder.stdout.once('data', r));
  assert.equal(await acquireLock(port), null);
  holder.kill('SIGKILL');
  await new Promise((r) => holder.on('exit', r));
  const again = await acquireLock(port);
  assert.ok(again);
  await again();
});
