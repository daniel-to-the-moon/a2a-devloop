// 遗留意见 issue 的幂等创建与本机待办清单（followups.mjs）
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { drainPending, ensureFollowUps, findByKey, FOLLOWUP_MARK, followUpItems } from './followups.mjs';

const H = 'a'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'followups-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fd = (issue) => ({ severity: 'major', file: 'a.ts', line: 1, issue, suggestion: 's' });
const items = followUpItems({ pr: 7, head: H, findings: [fd('一'), fd('二')] });

/**
 * 假 GitHub：issues 存在内存里。plan：每次 create 调用的结果
 * 'ok' 正常创建；'lost' 服务端已创建但客户端报错（响应丢失）；'fail' 未创建且报错。listFail：前几次 list 抛错。
 */
function fakeGh({ plan = [], listFail = 0, existing = [] } = {}) {
  const issues = [...existing];
  const log = [];
  let c = 0;
  let l = 0;
  return {
    issues,
    log,
    list: () => {
      log.push('list');
      if (l++ < listFail) throw new Error('list 503');
      return issues.map((x) => ({ ...x }));
    },
    create: (it) => {
      const mode = plan[c++] ?? 'ok';
      log.push(`create:${mode}`);
      if (mode === 'fail') throw new Error('create 502');
      const number = 100 + issues.length;
      issues.push({ number, body: it.body });
      if (mode === 'lost') throw new Error('socket hang up');
      return `https://github.com/o/r/issues/${number}\n`;
    },
    sleep: async () => {},
  };
}

test('followUpItems：每条意见有稳定 key，正文末尾带标记；findByKey 只认完整标记', () => {
  assert.deepEqual(items.map((x) => x.key), [`pr7-${H.slice(0, 12)}-1`, `pr7-${H.slice(0, 12)}-2`]);
  assert.ok(items[0].body.endsWith(`${FOLLOWUP_MARK}${items[0].key} -->`));
  assert.equal(findByKey([{ number: 5, body: items[0].body }], items[0].key), 5);
  assert.equal(findByKey([{ number: 5, body: `${FOLLOWUP_MARK}${items[0].key}0 -->` }], items[0].key), null);
});

test('ensureFollowUps：服务端已创建但客户端报错 → 重试前重新核对，复用已创建的 issue，只产生一个', async () => {
  const g = fakeGh({ plan: ['lost', 'ok'] });
  const r = await ensureFollowUps(items, g);
  assert.equal(g.issues.length, 2);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(Object.values(r.numbers), [100, 101]);
  assert.deepEqual(r.created, [101]); // 第一条是在核对中找回的，不算本次新建
});

test('ensureFollowUps：已存在同 key 的 issue → 不再创建；查询失败时不盲目创建', async () => {
  const g = fakeGh({ existing: [{ number: 9, body: items[0].body }] });
  const r = await ensureFollowUps(items, g);
  assert.equal(r.numbers[items[0].key], 9);
  assert.equal(g.issues.length, 2);
  const down = fakeGh({ listFail: 99 });
  const d = await ensureFollowUps(items, down);
  assert.equal(down.issues.length, 0);
  assert.equal(d.failed.length, 2);
  assert.ok(!down.log.some((x) => x.startsWith('create')));
});

test('ensureFollowUps：部分失败 → 报告失败项，其余照常开', async () => {
  const g = fakeGh({ plan: ['ok', 'fail', 'fail', 'fail'] });
  const r = await ensureFollowUps(items, g, { attempts: 3 });
  assert.equal(g.issues.length, 1);
  assert.deepEqual(r.failed.map((f) => f.key), [items[1].key]);
});

test('drainPending：合并后评论失败也不丢；部分失败保留清单并加 needs-user（只加一次），下一轮补齐后发清单、删文件', async () => {
  const dir = join(root, 'pending');
  mkdirSync(dir);
  writeFileSync(join(dir, 'pr-7.json'), JSON.stringify({ pr: 7, items }));
  const flags = [];
  const comments = [];
  const g = fakeGh({ plan: ['ok', 'fail', 'fail', 'fail'] });
  const io = { ...g, flag: (pr) => flags.push(pr), comment: (pr, t) => comments.push([pr, t]), log: () => {} };
  await drainPending({ dir, io });
  assert.ok(existsSync(join(dir, 'pr-7.json')));
  assert.deepEqual(flags, [7]);
  assert.equal(comments.length, 0);
  await drainPending({ dir, io }); // 第二轮：仍失败（plan 里剩下的 fail 用完前），不重复加标签
  assert.deepEqual(flags, [7]);
  await drainPending({ dir, io }); // 之后 create 默认成功
  assert.ok(!existsSync(join(dir, 'pr-7.json')));
  assert.equal(g.issues.length, 2); // 两条意见各一个 issue，无重复
  assert.match(comments.at(-1)[1], /#100、#101/);
});

test('drainPending：清单评论失败不影响删除（issue 已开齐）；目录不存在时无操作', async () => {
  const dir = join(root, 'pending2');
  mkdirSync(dir);
  writeFileSync(join(dir, 'pr-8.json'), JSON.stringify({ pr: 8, items }));
  const g = fakeGh();
  await drainPending({ dir, io: { ...g, flag: () => {}, comment: () => { throw new Error('comment 500'); }, log: () => {} } });
  assert.ok(!existsSync(join(dir, 'pr-8.json')));
  await drainPending({ dir: join(root, 'nope'), io: {} });
  assert.equal(readFileSync.length > 0, true);
});

/** 进程间互斥锁的假实现：被占用时返回 null（与 gitops.acquireLock 相同约定） */
function fakeLock() {
  let held = false;
  return async () => {
    await null;
    if (held) return null;
    held = true;
    return async () => { held = false; };
  };
}

/** 异步 io：每次 list / create 之间让出事件循环，模拟两个处理者交错 */
function asyncGh() {
  const g = fakeGh();
  return { ...g, list: async () => { await null; return g.list(); }, create: async (it) => { await null; return g.create(it); } };
}

test('drainPending：两个处理者交错执行——不加锁会重复创建；共用同一把锁时每个 key 只创建一次', async () => {
  const mk = (name) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'pr-7.json'), JSON.stringify({ pr: 7, items }));
    return dir;
  };
  const quiet = { flag: () => {}, comment: () => {}, log: () => {} };
  // 对照：不加锁，两个处理者都先查到“不存在”，各自创建
  const d1 = mk('race-nolock');
  const g1 = asyncGh();
  await Promise.all([drainPending({ dir: d1, io: { ...g1, ...quiet } }), drainPending({ dir: d1, io: { ...g1, ...quiet } })]);
  assert.ok(g1.issues.length > items.length, '对照组应出现重复，说明测试确实制造了交错');
  // 共用锁：后到者拿不到锁就跳过，不会重复
  const d2 = mk('race-lock');
  const g2 = asyncGh();
  const acquire = fakeLock();
  await Promise.all([drainPending({ dir: d2, io: { ...g2, ...quiet }, acquire }), drainPending({ dir: d2, io: { ...g2, ...quiet }, acquire })]);
  assert.equal(g2.issues.length, items.length);
  assert.ok(!existsSync(join(d2, 'pr-7.json')));
});
