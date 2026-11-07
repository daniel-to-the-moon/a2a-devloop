// node --test scripts/devloop/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, eligible, marker, MAX_CI_RETRIES, MAX_ROUNDS, parseMarkers, roundsUsed, shouldReview } from './policy.mjs';

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
