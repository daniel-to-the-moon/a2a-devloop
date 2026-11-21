// 云端审核 cloud.mjs：选择逻辑、后续动作、select 子命令（假 gh）以及 gpt-review.yml 的权限结构
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { finalize, followUps, loadReview, pickPr, runDecide, trustedReviewer } from './cloud.mjs';
import { touchesWorkflows, validateReview } from './review-format.mjs';
import { decide, MAX_CI_RETRIES, roundsUsed } from './policy.mjs';
import { marker } from './policy.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'cloud-'));
after(() => rmSync(root, { recursive: true, force: true }));
const KEY = 'k';
const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const open = { state: 'OPEN', isDraft: false, baseRefName: 'main', labels: [], markers: [] };

test('pickPr：按编号取第一个需要审的；跳过改工作流的、已有终态的、暂停的、草稿', () => {
  const s = (n, extra = {}) => ({ number: n, headRefOid: `${n}`.repeat(40).slice(0, 40), files: ['src/a.ts'], ...open, ...extra });
  assert.equal(pickPr([s(5), s(3)]).number, 3);
  assert.equal(pickPr([s(3, { files: ['.github/workflows/ci.yml', 'src/a.ts'] }), s(5)]).number, 5);
  assert.equal(pickPr([s(3, { labels: ['hold'] }), s(4, { isDraft: true }), s(5)]).number, 5);
  const done = s(3);
  done.markers = [{ state: 'changes', reason: 'none', head: done.headRefOid, base: B }];
  assert.equal(pickPr([done]), null);
  assert.equal(pickPr([]), null);
});

test('followUps：需修改 → 触发 claude.yml 修复；合并 → 触发 main 发布；其余无后续', () => {
  assert.deepEqual(followUps('changes', 7), [['workflow', 'run', 'claude.yml', '-f', 'pr=7']]);
  assert.deepEqual(followUps('merged', 7), [['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', 'deploy_main=true']]);
  for (const st of ['retry', 'stopped']) assert.deepEqual(followUps(st, 7), []);
});

/** 假 gh：pr list / pr view / commits/main；记录调用；`api user` 一律失败（GITHUB_TOKEN 无法查 user） */
function fakeGh(prs) {
  const dir = mkdtempSync(join(root, 'gh-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const p of prs) {
    const { files, ...view } = p.view;
    writeFileSync(join(dir, `pr-${p.number}.json`), JSON.stringify(view));
    writeFileSync(join(dir, `files-${p.number}.txt`), files.join('\n') + '\n');
  }
  writeFileSync(join(dir, 'list.json'), JSON.stringify(prs.map((p) => ({ number: p.number }))));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/gh.log"
if [ "$1 $2" = "api user" ]; then echo "Resource not accessible by integration" >&2; exit 1; fi
if [ "$1 $2" = "pr list" ]; then cat "${dir}/list.json"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then cat "${dir}/pr-$3.json"; exit 0; fi
if [ "$1 $2" = "api --paginate" ] && [[ "$3" =~ ^repos/o/r/pulls/([0-9]+)/files ]]; then cat "${dir}/files-\${BASH_REMATCH[1]}.txt"; exit 0; fi
if [ "$1" = api ] && [[ "$2" == repos/*/commits/main ]]; then echo "${B}"; exit 0; fi
echo "unexpected: $*" >&2; exit 1
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { path: `${bin}:${process.env.PATH}`, log: () => readFileSync(join(dir, 'gh.log'), 'utf8') };
}

const view = (head, { files = ['src/a.ts'], comments = [] } = {}) => ({
  title: 't', body: 'b', headRefOid: head, headRefName: 'claude/x', isCrossRepository: false, baseRefName: 'main',
  state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', labels: [], comments, files,
});
const botReview = (pr, state, head) => ({ author: { login: 'github-actions' }, body: `执行者：GPT（云端）\n${marker(KEY, { pr, state, head, base: B })}` });

function select(prs, extraArgs = []) {
  const g = fakeGh(prs);
  const out = join(root, `out-${Math.random()}`);
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, [join(HERE, 'cloud.mjs'), 'select', ...extraArgs], {
    env: { ...process.env, PATH: g.path, REPO: 'o/r', DEVLOOP_MARKER_KEY: KEY, GITHUB_OUTPUT: out, GITHUB_REPOSITORY_OWNER: 'owner' },
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr, out: readFileSync(out, 'utf8'), log: g.log() };
}

test('select：不调用 gh api user；跳过改工作流的 PR；认得云端机器人发的签名标记', () => {
  const r = select([
    { number: 3, view: view(H, { files: ['.github/workflows/x.yml'] }) },
    { number: 4, view: view('c'.repeat(40), { comments: [botReview(4, 'changes', 'c'.repeat(40))] }) },
    { number: 5, view: view('d'.repeat(40)) },
  ]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^pr=5\nhead=d{40}\nbase=b{40}\n/);
  assert.doesNotMatch(r.log, /^api user/m);
});

test('select：没有可审的 PR 时输出空 pr；--pr 只看指定的那个', () => {
  assert.match(select([{ number: 3, view: view(H, { files: ['.github/workflows/x.yml'] }) }]).out, /^pr=\n/);
  const r = select([{ number: 3, view: view(H) }, { number: 9, view: view('e'.repeat(40)) }], ['--pr', '9']);
  assert.match(r.out, /^pr=9\n/);
  assert.doesNotMatch(r.log, /pr list/);
});

test('gpt-review.yml：review 只读且以 :read-only 运行 codex、不持有签名密钥；decide 不运行模型；全局串行；开关', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/gpt-review.yml'), 'utf8');
  const job = (name) => yml.match(new RegExp(`^  ${name}:\\n((?:(?: {4,}.*)?\\n)*)`, 'm'))?.[1] ?? '';
  const [select, review, decide] = ['select', 'review', 'decide'].map(job);
  assert.ok(select && review && decide);
  for (const j of [select, review]) assert.doesNotMatch(j, /: write$/m);
  assert.match(review, /uses: openai\/codex-action@bdf19a4a223ec2549a3e2274a0cf61556bc07675 /);
  assert.match(review, /permission-profile: ':read-only'/);
  assert.match(review, /persist-credentials: false/);
  // 签名密钥只在 prompt 这一步（不在运行 codex 的那一步）出现
  const codexStep = review.slice(review.indexOf('- name: GPT 审核'), review.indexOf('- uses: actions/upload-artifact'));
  assert.doesNotMatch(codexStep, /DEVLOOP_MARKER_KEY/);
  assert.doesNotMatch(decide, /uses: openai\/codex-action/);
  assert.match(decide, /^ {6}contents: write$/m);
  assert.match(decide, /^ {6}actions: write$/m);
  assert.match(yml, /^concurrency:\n {2}group: gpt-review\n {2}cancel-in-progress: false\n {2}queue: max$/m);
  assert.match(select, /^ {4}if: github\.ref == 'refs\/heads\/main' && \(vars\.CLOUD_REVIEW == 'on' \|\| github\.event_name == 'workflow_dispatch'\)$/m);
});

const ownerReview = (pr, state, head) => ({ author: { login: 'owner' }, body: `执行者：GPT（经 devloop 审核）\n${marker(KEY, { pr, state, head, base: B })}` });

test('select：认本机审核方（仓库所有者）发的签名标记——本机审过的 head 云端不再重审', () => {
  const head = 'f'.repeat(40);
  const r = select([{ number: 6, view: view(head, { comments: [ownerReview(6, 'changes', head)] }) }]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^pr=\n/);
  // 伪造：别的账号发的同样内容不算
  const forged = { author: { login: 'mallory' }, body: ownerReview(6, 'changes', head).body };
  assert.match(select([{ number: 6, view: view(head, { comments: [forged] }) }]).out, /^pr=6\n/);
});

test('trustedReviewer：取 LOCAL_REVIEWER 或 GITHUB_REPOSITORY_OWNER；都没有就报错', () => {
  assert.equal(trustedReviewer({ GITHUB_REPOSITORY_OWNER: 'o' }), 'o');
  assert.equal(trustedReviewer({ LOCAL_REVIEWER: 'l', GITHUB_REPOSITORY_OWNER: 'o' }), 'l');
  assert.throws(() => trustedReviewer({}));
});

test('轮次连续：本机与云端的 changes 标记混合计数', () => {
  const ms = [{ state: 'changes', head: '1' }, { state: 'changes', head: '2' }, { state: 'retry', reason: 'infra', head: '3' }];
  assert.equal(roundsUsed(ms), 2);
});

/** 假 ghR：按命令前缀决定失败次数，记录调用顺序 */
function fakeGhR(failures = {}) {
  const calls = [];
  const left = { ...failures };
  const ghR = (args) => {
    const k = args.slice(0, 3).join(' ');
    calls.push(k);
    for (const [prefix, n] of Object.entries(left)) {
      if (k.startsWith(prefix) && n > 0) {
        left[prefix] = n - 1;
        throw new Error(`boom ${prefix}`);
      }
    }
    return '';
  };
  return { ghR, calls };
}
const fin = (o) => finalize({ pr: 7, body: 'B', writeBody: (t) => `/tmp/${t.length}`, sleep: async () => {}, delayMs: 0, ...o });

test('finalize 合并：先触发部署再发评论；全部成功不加标签', async () => {
  const f = fakeGhR();
  await fin({ ghR: f.ghR, state: 'merged' });
  assert.deepEqual(f.calls, ['workflow run ci.yml', 'pr comment 7']);
});

test('finalize 合并：评论一直失败也照样部署；最终加 needs-user、发说明、抛错', async () => {
  const f = fakeGhR({ 'pr comment': 99 });
  await assert.rejects(fin({ ghR: f.ghR, state: 'merged' }), /发审核评论/);
  assert.equal(f.calls[0], 'workflow run ci.yml');
  assert.ok(f.calls.includes('pr edit 7'));
});

test('finalize 需修改：发评论后触发修复；触发偶发失败会重试成功', async () => {
  const f = fakeGhR({ 'workflow run claude.yml': 2 });
  await fin({ ghR: f.ghR, state: 'changes' });
  assert.deepEqual(f.calls, ['pr comment 7', 'workflow run claude.yml', 'workflow run claude.yml', 'workflow run claude.yml']);
});

test('finalize 需修改：触发一直失败 → 重试 3 次后 needs-user + 说明 + 抛错；评论失败则不触发修复', async () => {
  const a = fakeGhR({ 'workflow run claude.yml': 99 });
  await assert.rejects(fin({ ghR: a.ghR, state: 'changes' }), /触发云端 Claude 修复/);
  assert.equal(a.calls.filter((c) => c === 'workflow run claude.yml').length, 3);
  assert.ok(a.calls.includes('pr edit 7'));
  const b = fakeGhR({ 'pr comment': 99 });
  await assert.rejects(fin({ ghR: b.ghR, state: 'changes' }));
  assert.ok(!b.calls.includes('workflow run claude.yml'));
});

test('finalize retry / stopped：只发评论，无后续动作', async () => {
  for (const state of ['retry', 'stopped']) {
    const f = fakeGhR();
    await fin({ ghR: f.ghR, state });
    assert.deepEqual(f.calls, ['pr comment 7']);
  }
});

test('touchesWorkflows：工作流移入、移出、删除都算；普通文件改名不算', () => {
  assert.equal(touchesWorkflows(['ci/old.yml', '.github/workflows/ci.yml']), true); // 移入（新路径在目录内）
  assert.equal(touchesWorkflows(['archived/ci.yml', '.github/workflows/ci.yml']), true); // 移出（旧路径在目录内）
  assert.equal(touchesWorkflows(['.github/workflows/old.yml']), true); // 删除
  assert.equal(touchesWorkflows(['src/b.ts', 'src/a.ts', '.github/ISSUE_TEMPLATE/x.md']), false); // 普通改名
});

test('select：把工作流移出目录的 PR 不归云端审', () => {
  const r = select([{ number: 3, view: view(H, { files: ['archived/ci.yml', '.github/workflows/ci.yml'] }) }]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^pr=\n/);
  assert.match(r.log, /pulls\/3\/files/);
});

/** 内存里的产物：files[path] = 内容 */
const mem = (files) => ({ read: (f) => files[f], exists: (f) => f in files });
const artifact = (meta, review = { verdict: 'approve', summary: 's', findings: [] }) =>
  mem({ 'r.json': JSON.stringify(review), 'm.json': JSON.stringify(meta) });
const want = { pr: 7, head: H, base: B, reviewPath: 'r.json', metaPath: 'm.json' };

test('loadReview：本次 review 任务未成功时，即使目录里有（上一次尝试的）approve 也不采用', () => {
  for (const reviewResult of ['failure', 'cancelled', 'skipped', '']) {
    const r = loadReview({ ...want, reviewResult, ...artifact({ pr: '7', head: H, base: B }) });
    assert.equal(r.review, null);
    assert.match(r.reviewError, /未成功/);
  }
});

test('loadReview：元数据的 pr / head / base 任一与本次判定不符 → 不采用（跨尝试、head 变化、base 变化）', () => {
  const other = 'c'.repeat(40);
  for (const meta of [{ pr: '7', head: other, base: B }, { pr: '7', head: H, base: other }, { pr: '8', head: H, base: B }, { head: H, base: B }]) {
    const r = loadReview({ ...want, reviewResult: 'success', ...artifact(meta) });
    assert.equal(r.review, null, JSON.stringify(meta));
    assert.match(r.reviewError, /不符/);
  }
});

test('loadReview：缺产物或元数据、无法解析 → 不采用；全部一致才采用', () => {
  assert.match(loadReview({ ...want, reviewResult: 'success', ...mem({ 'r.json': '{}' }) }).reviewError, /没有产出/);
  assert.match(loadReview({ ...want, reviewResult: 'success', ...mem({ 'r.json': '{', 'm.json': '{}' }) }).reviewError, /无法解析/);
  const ok = loadReview({ ...want, reviewResult: 'success', ...artifact({ pr: '7', head: H, base: B }) });
  assert.equal(ok.review.verdict, 'approve');
});

test('gpt-review.yml：产物名带 run_attempt、由 review 输出传给 decide；review 未成功不下载；元数据由工作流步骤写入', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/gpt-review.yml'), 'utf8');
  assert.match(yml, /artifact=gpt-review-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/);
  assert.match(yml, /artifact: \$\{\{ steps\.wrap\.outputs\.artifact \}\}/);
  assert.match(yml, /if: needs\.review\.result == 'success' && needs\.review\.outputs\.artifact != ''\n.*\n.*\n {10}name: \$\{\{ needs\.review\.outputs\.artifact \}\}/);
  assert.match(yml, /--review-result "\$REVIEW_RESULT" --review review\/review\.json --meta review\/meta\.json/);
  assert.doesNotMatch(yml, /name: gpt-review-\$\{\{ github\.run_id \}\}\n/);
});

const okReview = { verdict: 'approve', summary: 'ok', findings: [{ severity: 'minor', file: 'a.ts', line: 3, issue: 'i', suggestion: 's' }] };

test('validateReview：符合 review-schema.json 才通过；结构错误逐类拒绝', () => {
  assert.equal(validateReview(okReview), '');
  assert.equal(validateReview({ verdict: 'request_changes', summary: '', findings: [] }), '');
  const bad = [
    null, [], 'x',
    { verdict: 'approve', summary: 'ok', findings: {} }, // findings 不是数组
    { verdict: 'approve', summary: 'ok' }, // 缺 findings
    { verdict: 'approve', findings: [] }, // 缺 summary
    { verdict: 'lgtm', summary: 'ok', findings: [] }, // 非法 verdict
    { verdict: 'approve', summary: 'ok', findings: [], extra: 1 }, // 多余字段
    { ...okReview, findings: [{ ...okReview.findings[0], severity: 'critical' }] }, // 非法 severity
    { ...okReview, findings: [{ ...okReview.findings[0], line: '3' }] }, // line 不是整数
    { ...okReview, findings: [{ ...okReview.findings[0], file: undefined }] }, // 缺 file
    { ...okReview, findings: [null] },
  ];
  for (const r of bad) assert.notEqual(validateReview(r), '', JSON.stringify(r));
});

test('loadReview：合法 JSON 但结构不符 → 不采用，按基础设施问题处理且累计到停止上限', () => {
  const r = loadReview({ ...want, reviewResult: 'success', ...artifact({ pr: '7', head: H, base: B }, { verdict: 'approve', summary: 'ok', findings: {} }) });
  assert.equal(r.review, null);
  assert.match(r.reviewError, /review-schema/);
  const now = { labels: [], base: B, mergeable: 'MERGEABLE', state: 'OPEN', isDraft: false, baseRefName: 'main' };
  const states = [];
  for (let i = 0; i < MAX_CI_RETRIES; i++) {
    const d = decide({ ci: { status: 'ok', base: B }, review: r.review, now, roundsBefore: 0, retriesForHead: i, allowMerge: true });
    states.push(`${d.state}:${d.reason ?? ''}`);
  }
  assert.deepEqual(states.slice(0, -1), Array(MAX_CI_RETRIES - 1).fill('retry:infra'));
  assert.match(states.at(-1), /^stopped/);
});

test('gpt-review.yml：无 pull_request 入口；每个任务都校验 github.ref 为 main', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/gpt-review.yml'), 'utf8');
  const on = yml.match(/^on:\n((?: .*\n)*)/m)[1];
  assert.doesNotMatch(on, /pull_request/);
  assert.doesNotMatch(yml, /github\.event\.pull_request/);
  const ifs = [...yml.matchAll(/^ {4}if: (.*)$/gm)].map((m) => m[1]);
  assert.equal(ifs.length, 3);
  for (const c of ifs) assert.match(c, /github\.ref == 'refs\/heads\/main'/);
});

/** 真 git 仓库：base ← h0 ← h1；返回各提交 SHA 与目录 */
function gitRepo() {
  const dir = mkdtempSync(join(root, 'repo-'));
  const g = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).stdout.trim();
  g('init', '-q');
  const commit = (f) => { writeFileSync(join(dir, f), f); g('add', f); g('commit', '-qm', f); return g('rev-parse', 'HEAD'); };
  return { dir, g, base: commit('base.txt'), h0: commit('a.txt'), h1: commit('b.txt') };
}

function prompt({ liveHead, checkout, head }) {
  const r0 = gitRepo();
  r0.g('checkout', '-q', { h0: r0.h0, h1: r0.h1 }[checkout]);
  const g = fakeGh([{ number: 7, view: view({ h0: r0.h0, h1: r0.h1 }[liveHead]) }]);
  const outFile = join(root, `prompt-${Math.random()}.md`);
  const r = spawnSync(process.execPath, [join(HERE, 'cloud.mjs'), 'prompt', '--pr', '7', '--head', { h0: r0.h0, h1: r0.h1 }[head], '--base', r0.base, '--dir', r0.dir, '--out', outFile], {
    env: { ...process.env, PATH: g.path, REPO: 'o/r', DEVLOOP_MARKER_KEY: KEY, GITHUB_REPOSITORY_OWNER: 'owner' },
    encoding: 'utf8',
  });
  let text = null;
  try { text = readFileSync(outFile, 'utf8'); } catch { /* 未生成 */ }
  return { code: r.status, err: r.stderr, text, r0 };
}

test('prompt：选定 head、PR 当前 head、检出 HEAD 一致时，提示词与 diff 用该固定 SHA', () => {
  const p = prompt({ liveHead: 'h1', checkout: 'h1', head: 'h1' });
  assert.equal(p.code, 0, p.err);
  assert.match(p.text, new RegExp(`审核提交：${p.r0.h1}`));
  assert.match(p.text, /b\.txt/); // diff 覆盖到 h1 的改动
});

test('prompt：PR 被暂时重置到本地已有的祖先（或检出与选定不符）→ 终止，不生成可供合并的提示词', () => {
  for (const c of [{ liveHead: 'h0', checkout: 'h1', head: 'h1' }, { liveHead: 'h1', checkout: 'h0', head: 'h1' }, { liveHead: 'h0', checkout: 'h0', head: 'h1' }]) {
    const p = prompt(c);
    assert.notEqual(p.code, 0, JSON.stringify(c));
    assert.equal(p.text, null, JSON.stringify(c));
    assert.match(p.err, /审核对象不一致/);
  }
});

test('gpt-review.yml：prompt 收到 select 选定的 head', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/gpt-review.yml'), 'utf8');
  assert.match(yml, /cloud\.mjs prompt --pr "\$\{\{ needs\.select\.outputs\.pr \}\}" --head "\$\{\{ needs\.select\.outputs\.head \}\}"/);
});

/**
 * decide 入口级测试：替换 GitHub / CI / git 接口，记录调用顺序。
 * states：prState 依次返回的 PR 状态（最后一个重复使用）；push：'ok' | 'fail'（mergeAndPush 是否抛错，成功前会先调用 beforePush）
 */
function decideRig({ reviewResult = 'success', review = { verdict: 'approve', summary: 'ok', findings: [] }, ci = 'ok', states = [{}], push = 'ok', mainBase = B, limitMode } = {}) {
  const calls = [];
  const pr = { title: 't', headRefOid: H, headRefName: 'claude/x', isCrossRepository: false, baseRefName: 'main', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', labels: [], markers: [], files: ['src/a.ts'] };
  let i = 0;
  const io = {
    key: KEY,
    model: 'm',
    limitMode,
    sleep: async () => {},
    ghR: (args) => { calls.push(args.slice(0, 3).join(' ')); return args[0] === 'issue' && args[1] === 'create' ? `https://github.com/o/r/issues/${90 + calls.filter((c) => c.startsWith('issue create')).length}\n` : ''; },
    prState: () => ({ ...pr, ...states[Math.min(i++, states.length - 1)] }),
    mainSha: () => mainBase,
    runCi: async (p) => { calls.push(`ci ${p.pr} ${p.head.slice(0, 4)} ${p.base.slice(0, 4)}`); return { status: ci, base: B, url: '' }; },
    fetch: () => calls.push('fetch'),
    mergeAndPush: (opts) => {
      calls.push(`merge ${opts.base.slice(0, 4)}+${opts.head.slice(0, 4)}`);
      opts.beforePush();
      if (push === 'fail') throw new Error('push rejected');
      calls.push('pushed');
      return { sha: 'd'.repeat(40), branchDeleted: true };
    },
    writeBody: () => 'body.md',
  };
  const files = { 'r.json': JSON.stringify(review), 'm.json': JSON.stringify({ pr: '7', head: H, base: B }) };
  const run = () => runDecide({ pr: 7, head: H, base: B, reviewResult, reviewPath: 'r.json', metaPath: 'm.json', read: (f) => files[f], exists: (f) => f in files }, io);
  return { calls, run };
}
const merged = (calls) => calls.includes('pushed');
const deployed = (calls) => calls.some((c) => c.startsWith('workflow run ci.yml'));

test('runDecide：审核与 CI 都通过 → 在测试过的 base 上合并，先部署再评论', async () => {
  const r = decideRig();
  const out = await r.run();
  assert.equal(out.state, 'merged');
  assert.deepEqual(r.calls, ['ci 7 aaaa bbbb', 'fetch', 'merge bbbb+aaaa', 'pushed', 'workflow run ci.yml', 'pr comment 7']);
});

test('runDecide：review 任务失败但 CI 成功 → 不合并、不部署，记基础设施重试并评论', async () => {
  const r = decideRig({ reviewResult: 'failure' });
  const out = await r.run();
  assert.equal(out.state, 'retry');
  assert.ok(!merged(r.calls) && !deployed(r.calls));
  assert.ok(r.calls.includes('pr comment 7'));
});

test('runDecide：head 变化或改动工作流 → 跳过，不评论、不合并、不触发任何后续', async () => {
  for (const st of [{ headRefOid: 'c'.repeat(40) }, { files: ['archived/ci.yml', '.github/workflows/ci.yml'] }]) {
    const r = decideRig({ states: [st] });
    assert.equal((await r.run()).state, 'skipped');
    assert.deepEqual(r.calls, ['ci 7 aaaa bbbb']);
  }
});

test('runDecide：暂停标签 → 不合并；推送前才出现暂停 / head 变化 / 改工作流 → 不推送、不部署', async () => {
  const a = decideRig({ states: [{ labels: ['hold'] }] });
  assert.equal((await a.run()).state, 'retry');
  assert.ok(!a.calls.some((c) => c.startsWith('merge')) && !deployed(a.calls));
  for (const late of [{ labels: ['hold'] }, { headRefOid: 'c'.repeat(40) }, { files: ['.github/workflows/x.yml'] }, { state: 'CLOSED' }]) {
    const b = decideRig({ states: [{}, late] });
    assert.equal((await b.run()).state, 'retry', JSON.stringify(late));
    assert.ok(!merged(b.calls) && !deployed(b.calls), JSON.stringify(late));
  }
});

test('runDecide：推送失败 → retry:merge，不部署', async () => {
  const r = decideRig({ push: 'fail' });
  assert.equal((await r.run()).state, 'retry');
  assert.ok(!deployed(r.calls));
  assert.ok(r.calls.includes('pr comment 7'));
});

test('runDecide：main 在测试后变化 → 不合并', async () => {
  const r = decideRig({ mainBase: 'e'.repeat(40) });
  assert.equal((await r.run()).state, 'retry');
  assert.ok(!r.calls.some((c) => c.startsWith('merge')));
});

test('runDecide：需修改 → 先评论成功再触发云端修复；CI 失败同样退回', async () => {
  const a = decideRig({ review: { verdict: 'request_changes', summary: 'x', findings: [] } });
  assert.equal((await a.run()).state, 'changes');
  assert.deepEqual(a.calls, ['ci 7 aaaa bbbb', 'pr comment 7', 'workflow run claude.yml']);
  const b = decideRig({ ci: 'failed' });
  assert.equal((await b.run()).state, 'changes');
  assert.ok(!merged(b.calls) && !deployed(b.calls));
});

test('runDecide：该 head 已有终态标记（重放，或另一审核方先写了 changes / merged / stopped）→ 跳过，不评论、不触发、不合并', async () => {
  for (const state of ['changes', 'merged', 'stopped']) {
    const r = decideRig({ states: [{ markers: [{ state, reason: 'none', head: H, base: B }] }] });
    assert.equal((await r.run()).state, 'skipped', state);
    assert.deepEqual(r.calls, ['ci 7 aaaa bbbb'], state);
  }
  // 其他 head 的终态、本 head 的 retry 不影响
  const ok = decideRig({ states: [{ markers: [{ state: 'changes', reason: 'none', head: 'c'.repeat(40), base: B }, { state: 'retry', reason: 'infra', head: H, base: B }] }] });
  assert.equal((await ok.run()).state, 'merged');
});

test('runDecide：判定后、推送前另一审核方写入 changes → 不推送、不部署', async () => {
  const r = decideRig({ states: [{}, { markers: [{ state: 'changes', reason: 'none', head: H, base: B }] }] });
  assert.equal((await r.run()).state, 'retry');
  assert.ok(!merged(r.calls) && !deployed(r.calls));
});

test('runDecide auto：轮次用满、意见持平无 blocker → 合并、部署、评论，再逐条开 devloop issue 并按 issue 触发实现', async () => {
  const changes = (h, n) => ({ state: 'changes', reason: `f${n}`, head: h, base: B });
  const markers = ['1', '2', '3', '4', '5'].map((c, i) => changes(c.repeat(40), i === 4 ? 2 : 3));
  const review = { verdict: 'request_changes', summary: 'x', findings: [fd2('major'), fd2('minor')] };
  const r = decideRig({ review, limitMode: 'auto', states: [{ markers }] });
  assert.equal((await r.run()).state, 'merged');
  assert.deepEqual(r.calls, [
    'ci 7 aaaa bbbb', 'fetch', 'merge bbbb+aaaa', 'pushed', 'workflow run ci.yml', 'pr comment 7',
    'issue create --title', 'issue create --title', 'workflow run claude.yml', 'workflow run claude.yml', 'pr comment 7',
  ]);
  // 默认 needs-user：同样情形停下，不合并
  const d = decideRig({ review, states: [{ markers }] });
  assert.equal((await d.run()).state, 'stopped');
  assert.ok(!merged(d.calls) && d.calls.includes('pr edit 7'));
});

function fd2(severity) {
  return { severity, file: 'a.ts', line: 1, issue: '问题', suggestion: '建议' };
}

test('followUpIssues：每条意见一个 issue，含来源、位置、建议与验收标准；标题截断', async () => {
  const { followUpIssues } = await import('./review-format.mjs');
  const [a] = followUpIssues({ pr: 7, head: H, findings: [{ ...fd2('major'), issue: 'x'.repeat(300) }] });
  assert.ok(a.title.startsWith('[#7 遗留·major] ') && a.title.length <= 120);
  for (const k of ['PR #7', 'a.ts:1', '## 建议', '## 验收标准', '- [ ]']) assert.ok(a.body.includes(k), k);
});

test('gpt-review.yml：decide 读取仓库变量 ROUND_LIMIT_MODE', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/gpt-review.yml'), 'utf8');
  assert.match(yml, /ROUND_LIMIT_MODE: \$\{\{ vars\.ROUND_LIMIT_MODE \}\}/);
});

test('finalize：issue 创建成功但响应丢失 → 重新核对找回编号，仍触发该 issue 的实现，不重复创建', async () => {
  const { followUpItems } = await import('./followups.mjs');
  const its = followUpItems({ pr: 7, head: H, findings: [fd2('major')] });
  const created = [];
  const calls = [];
  const ghR = (args) => {
    calls.push(args.slice(0, 4).join(' '));
    if (args[0] === 'issue' && args[1] === 'create') {
      created.push({ number: 300 + created.length, body: its[0].body });
      throw new Error('socket hang up'); // 服务端已创建，客户端没拿到响应
    }
    return '';
  };
  await finalize({ ghR, pr: 7, state: 'merged', body: 'b', writeBody: () => 'f.md', issues: its, listIssues: () => created, sleep: async () => {}, delayMs: 0 });
  assert.equal(created.length, 1);
  assert.ok(calls.includes('workflow run claude.yml -f'));
  assert.equal(calls.filter((c) => c.startsWith('issue create')).length, 1);
});
