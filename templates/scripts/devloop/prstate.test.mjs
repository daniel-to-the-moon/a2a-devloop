// node --test scripts/devloop/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marker, shouldReview } from './policy.mjs';
import { createPrState } from './prstate.mjs';

const KEY = 'test-key';
const REPO = 'owner/repo';
const PR = 4;
const H = 'a'.repeat(40);
const B = 'b'.repeat(40);

/**
 * 假 gh：模拟 GitHub 账号改名——当前登录名与历史评论作者同时变成新名（账号 id 不变，GitHub 对历史评论也显示新名）。
 * comments：[{ by: 'reviewer' | 'other', body }]，作者在每次查询时按当前名字渲染。
 */
function fakeGh(comments) {
  const s = { login: 'old-name', other: 'someone-else', calls: [] };
  s.gh = (args) => {
    s.calls.push(args.join(' '));
    if (args[0] === 'api' && args[1] === 'user') return `${s.login}\n`;
    if (args[0] === 'api' && args[1] === '--paginate' && args[2] === `repos/${REPO}/pulls/${PR}/files?per_page=100`) return (s.files ?? ['src/a.ts']).join('\n') + '\n';
    if (args[0] === 'pr' && args[1] === 'view') {
      assert.equal(args[2], String(PR));
      assert.deepEqual(args.slice(-2), ['-R', REPO]);
      return JSON.stringify({
        title: 't', body: '', headRefOid: H, headRefName: 'claude/issue-4', isCrossRepository: false,
        baseRefName: 'main', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', labels: [],
        comments: comments.map((c) => ({ author: { login: c.by === 'reviewer' ? s.login : s.other }, body: c.body })),
      });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return s;
}

const review = (state, head = H) => `执行者：GPT（审核）\n…\n${marker(KEY, { pr: PR, state, head, base: B })}`;
const wantsReview = (m) => shouldReview({ head: m.headRefOid, labels: m.labels, markers: m.markers, pr: m });

test('账号改名后：同一进程内仍认得自己的终态标记，不重复审核同一提交', () => {
  const f = fakeGh([{ by: 'reviewer', body: review('changes') }]);
  const prState = createPrState({ gh: f.gh, repo: REPO, key: KEY });

  const before = prState(PR);
  assert.equal(before.markers.length, 1);
  assert.equal(wantsReview(before), false);

  f.login = 'new-name'; // 改名：登录名与历史评论作者同时变化
  const after = prState(PR);
  assert.equal(after.markers.length, 1, '改名后应仍识别审核方自己的签名标记');
  assert.equal(after.markers[0].state, 'changes');
  assert.equal(wantsReview(after), false, '改名后不应再次审核同一 head');
});

test('每次读取 PR 状态都重新查询审核方登录名', () => {
  const f = fakeGh([]);
  const prState = createPrState({ gh: f.gh, repo: REPO, key: KEY });
  prState(PR);
  prState(PR);
  prState(PR);
  assert.equal(f.calls.filter((c) => c === 'api user -q .login').length, 3);
});

test('改名后其他账号发的同签名格式评论仍不被认可', () => {
  const f = fakeGh([{ by: 'other', body: review('merged') }]);
  const prState = createPrState({ gh: f.gh, repo: REPO, key: KEY });
  f.login = 'new-name';
  const m = prState(PR);
  assert.equal(m.markers.length, 0);
  assert.equal(wantsReview(m), true);
});

test('files：含重命名前的旧路径（REST previous_filename），用于识别移出工作流目录的改动', () => {
  const f = fakeGh([]);
  f.files = ['archived/ci.yml', '.github/workflows/ci.yml', 'src/a.ts'];
  const prState = createPrState({ gh: f.gh, repo: REPO, key: KEY });
  assert.deepEqual(prState(PR).files, ['archived/ci.yml', '.github/workflows/ci.yml', 'src/a.ts']);
  assert.ok(f.calls.some((c) => c.includes('.previous_filename')));
});
