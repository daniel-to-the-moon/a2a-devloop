// node --test scripts/devloop/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, eligible, EXTRA_ROUNDS, lastFindings, limitMode, marker, MAX_CI_RETRIES, MAX_ROUNDS, parseMarkers, roundsUsed, shouldReview } from './policy.mjs';

const KEY = 'test-key';
const PR = 6;
const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const REV = 'reviewer';
const ok = { verdict: 'approve', findings: [] };
const minorOnly = { verdict: 'approve', findings: [{ severity: 'minor' }] };
const major = { verdict: 'approve', findings: [{ severity: 'major' }] };
const reject = { verdict: 'request_changes', findings: [] };
const now = { labels: [], base: B, mergeable: 'MERGEABLE' };
const base = { ci: { status: 'ok', base: B }, review: ok, now, roundsBefore: 0, allowMerge: true };

const reviewComment = (state, head = H, extra = {}) => ({
  author: REV,
  body: `执行者：GPT（审核）\n…\n${marker(KEY, { pr: PR, state, head, base: B })}`,
  ...extra,
});
const parse = (comments) => parseMarkers(comments, { key: KEY, reviewer: REV, pr: PR });

test('全部通过才合并；只有 minor 也可合并', () => {
  assert.equal(decide(base).merge, true);
  assert.equal(decide({ ...base, review: minorOnly }).merge, true);
});

test('approve 但带 major 视为未通过', () => {
  assert.equal(decide({ ...base, review: major }).state, 'changes');
});

test('测试失败、GPT 拒绝、冲突都进入 changes', () => {
  assert.equal(decide({ ...base, ci: { status: 'failed', base: B } }).state, 'changes');
  assert.equal(decide({ ...base, review: reject }).state, 'changes');
  assert.equal(decide({ ...base, now: { ...now, mergeable: 'CONFLICTING' } }).state, 'changes');
});

test('暂停标签优先：即使结论需修改也只记 retry，去掉标签后会重审', () => {
  for (const l of ['hold', 'needs-user']) {
    for (const review of [ok, reject]) {
      const d = decide({ ...base, review, now: { ...now, labels: [l] } });
      assert.equal(d.state, 'retry');
      assert.equal(d.merge, false);
    }
  }
  const markers = parse([reviewComment('retry')]);
  assert.equal(shouldReview({ head: H, labels: [], markers }), true);
});

test('测试之后 main 变了：不合并', () => {
  const d = decide({ ...base, now: { ...now, base: 'c'.repeat(40) } });
  assert.equal(d.merge, false);
  assert.equal(d.state, 'retry');
});

test('CI 基础设施出错、--no-merge：retry，不消耗轮次', () => {
  assert.equal(decide({ ...base, ci: { status: 'error', base: B }, review: reject }).state, 'retry');
  assert.equal(decide({ ...base, allowMerge: false }).state, 'retry');
});

test(`第 ${MAX_ROUNDS} 轮仍未通过：stopped + needs-user`, () => {
  const d = decide({ ...base, review: reject, roundsBefore: MAX_ROUNDS - 1 });
  assert.equal(d.state, 'stopped');
  assert.equal(d.addLabel, 'needs-user');
});

test('shouldReview：终态 head 不再审；retry 会重审；其他 head 的终态不影响；暂停标签跳过', () => {
  assert.equal(shouldReview({ head: H, labels: [], markers: [] }), true);
  for (const s of ['changes', 'merged', 'stopped']) assert.equal(shouldReview({ head: H, labels: [], markers: parse([reviewComment(s)]) }), false);
  assert.equal(shouldReview({ head: H, labels: [], markers: parse([reviewComment('changes', 'd'.repeat(40))]) }), true);
  assert.equal(shouldReview({ head: H, labels: ['hold'], markers: [] }), false);
});

test('防伪：别人发的、没签名的、签错的、别的 PR 的标记都无效', () => {
  const good = reviewComment('merged');
  assert.equal(parse([good]).length, 1);
  assert.equal(parse([{ ...good, author: 'someone-else' }]).length, 0);
  assert.equal(parse([{ ...good, body: good.body.replace('执行者：GPT', '执行者：Claude') }]).length, 0);
  assert.equal(parse([{ ...good, body: good.body.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(32)}`) }]).length, 0);
  assert.equal(parse([{ ...good, body: good.body.replace('state=merged', 'state=stopped') }]).length, 0);
  assert.equal(parseMarkers([good], { key: KEY, reviewer: REV, pr: 7 }).length, 0);
  assert.equal(parseMarkers([good], { key: 'other-key', reviewer: REV, pr: PR }).length, 0);
});

test('一条评论里塞多个标记只认最后一个；轮次按不同 head 计', () => {
  const stuffed = { author: REV, body: `执行者：GPT\n${[1, 2, 3, 4].map((i) => marker(KEY, { pr: PR, state: 'changes', head: String(i).repeat(40), base: B })).join('\n')}` };
  assert.equal(parse([stuffed]).length, 1);
  const markers = parse([reviewComment('changes'), reviewComment('changes'), reviewComment('retry', 'e'.repeat(40)), reviewComment('changes', 'f'.repeat(40))]);
  assert.equal(roundsUsed(markers), 2);
});

test('PR 状态：草稿、已关闭、目标不是 main 都不审、不合并', () => {
  const open = { state: 'OPEN', isDraft: false, baseRefName: 'main' };
  assert.equal(eligible(open), true);
  for (const bad of [{ ...open, isDraft: true }, { ...open, state: 'CLOSED' }, { ...open, state: 'MERGED' }, { ...open, baseRefName: 'dev' }]) {
    assert.equal(eligible(bad), false);
    assert.equal(shouldReview({ head: H, labels: [], markers: [], pr: bad }), false);
    const d = decide({ ...base, now: { ...now, ...bad } });
    assert.equal(d.merge, false);
    assert.equal(d.state, 'retry');
  }
});

test(`基础设施问题（CI 未完成 / GPT 审核失败）：同一提交第 ${MAX_CI_RETRIES} 次即 stopped + needs-user`, () => {
  for (const over of [{ ci: { status: 'error', base: B } }, { review: null }]) {
    const d0 = decide({ ...base, ...over, retriesForHead: 0 });
    assert.equal(d0.state, 'retry');
    assert.equal(d0.reason, 'infra');
    const d = decide({ ...base, ...over, retriesForHead: MAX_CI_RETRIES - 1 });
    assert.equal(d.state, 'stopped');
    assert.equal(d.addLabel, 'needs-user');
  }
  const c = { author: REV, body: `执行者：GPT\n${marker(KEY, { pr: PR, state: 'retry', reason: 'infra', head: H, base: B })}` };
  assert.deepEqual(parse([c]).map((m) => [m.state, m.reason]), [['retry', 'infra']]);
});

// ---- 轮次用满后的处理方式（ROUND_LIMIT_MODE） ----
const fd = (severity) => ({ severity, file: 'a.ts', line: 1, issue: 'i', suggestion: 's' });
const lim = (o = {}) => {
  const now0 = { labels: [], base: B, mergeable: 'MERGEABLE', state: 'OPEN', isDraft: false, baseRefName: 'main' };
  return decide({
    ci: { status: 'ok', base: B, ...(o.ci ?? {}) },
    review: { verdict: 'request_changes', summary: 's', findings: o.findings ?? [fd('major')] },
    now: { ...now0, ...(o.now ?? {}) },
    roundsBefore: o.roundsBefore ?? MAX_ROUNDS - 1,
    allowMerge: o.allowMerge ?? true,
    mode: 'mode' in o ? o.mode : 'auto',
    prevFindings: o.prev === undefined ? 2 : o.prev,
  });
};

test('limitMode：只认 needs-user / auto，其余（含空）按 needs-user', () => {
  assert.equal(limitMode('auto'), 'auto');
  for (const v of ['', undefined, 'AUTO', 'merge']) assert.equal(limitMode(v), 'needs-user');
});

test('needs-user 模式（默认）：轮次用满即停、加 needs-user，与原行为一致', () => {
  for (const mode of ['needs-user', undefined, 'bogus']) {
    const d = lim({ mode, findings: [fd('minor')], prev: 5 });
    assert.equal(d.state, 'stopped');
    assert.equal(d.addLabel, 'needs-user');
  }
});

test('auto：意见数减少 → 追加轮次（changes），直到第 MAX+EXTRA 轮', () => {
  const d = lim({ findings: [fd('major')], prev: 2 });
  assert.equal(d.state, 'changes');
  assert.equal(d.reason, 'f1');
  const last = lim({ findings: [fd('major')], prev: 2, roundsBefore: MAX_ROUNDS + EXTRA_ROUNDS - 1 });
  assert.equal(last.state, 'merged'); // 追加轮次用完、无 blocker、CI 通过 → 合并
  assert.equal(last.reason, 'limit');
});

test('auto：意见数持平（或上一轮无记录）、无 blocker、CI 通过 → 合并并带上遗留意见', () => {
  for (const prev of [1, null]) {
    const d = lim({ findings: [fd('major')], prev });
    assert.equal(d.state, 'merged', String(prev));
    assert.equal(d.merge, true);
    assert.deepEqual(d.followUpFindings, [fd('major')]);
  }
});

test('auto：有 blocker 或意见数增加 → 停下加 needs-user', () => {
  for (const o of [{ findings: [fd('blocker')], prev: 3 }, { findings: [fd('minor'), fd('minor'), fd('minor')], prev: 2 }]) {
    const d = lim(o);
    assert.equal(d.state, 'stopped', JSON.stringify(o));
    assert.equal(d.addLabel, 'needs-user');
  }
});

test('auto：CI 失败或冲突 → 追加轮次修复；追加用完仍失败 → 停下', () => {
  assert.equal(lim({ ci: { status: 'failed' }, prev: 1 }).state, 'changes');
  assert.equal(lim({ now: { mergeable: 'CONFLICTING' }, prev: 1 }).state, 'changes');
  assert.equal(lim({ ci: { status: 'failed' }, prev: 1, roundsBefore: MAX_ROUNDS + EXTRA_ROUNDS - 1 }).state, 'stopped');
});

test('auto：可合并但 main 已变 / --no-merge → retry，不合并', () => {
  assert.equal(lim({ prev: 1, now: { base: 'c'.repeat(40) } }).state, 'retry');
  assert.equal(lim({ prev: 1, allowMerge: false }).state, 'retry');
});

test('auto：未到轮次上限时行为不变；changes 标记记下意见数 f<n>，lastFindings 取最近一条', () => {
  const d = lim({ roundsBefore: 1, findings: [fd('minor'), fd('major')] });
  assert.equal(d.state, 'changes');
  assert.equal(d.reason, 'f2');
  const ms = [{ state: 'changes', reason: 'f4', head: H }, { state: 'retry', reason: 'infra', head: H }, { state: 'changes', reason: 'f2', head: B }];
  assert.equal(lastFindings(ms), 2);
  assert.equal(lastFindings([{ state: 'changes', reason: 'none', head: H }]), null);
  assert.equal(lastFindings([]), null);
  // 带 f<n> 的标记签名可验证
  const c = { author: REV, body: `执行者：GPT\n${marker(KEY, { pr: PR, state: 'changes', reason: 'f3', head: H, base: B })}` };
  assert.deepEqual(parse([c]).map((m) => [m.state, m.reason]), [['changes', 'f3']]);
});
