// claude.yml 用到的 ctx.sh / publish.sh 的行为测试：假 gh（记录调用、返回预设值）+ 真 git（本地临时远端）
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    `#!/usr/bin/env bash\necho "$*" >> "${join(dir, 'gh.log')}"\nif [ "$1 $2" = "pr view" ]; then printf '%s' "$FAKE_HEAD_REF"; fi\nif [ "$1 $2" = "issue view" ]; then q=""; prev=""; for a in "$@"; do [ "$prev" = "-q" ] && q="$a"; prev="$a"; done; printf '%s' "$FAKE_ISSUE_JSON" | jq -r "$q"; fi\nexit "\${FAKE_GH_EXIT:-0}"\n`,
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
  return { run, gh, out, remote, start, newSha, ref: (r) => execFileSync('git', ['rev-parse', r], { cwd: remote, encoding: 'utf8' }).trim() };
}

test('publish：fix 推送到分支并评论；评论触发不动标签', () => {
  const t = publishSetup();
  const r = t.run({ MODE: 'fix', EVENT: 'issue_comment' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.ref('refs/heads/claude/x'), t.newSha);
  assert.match(t.gh.log(), /^pr comment 4/m);
  assert.doesNotMatch(t.gh.log(), /remove-label/);
});

test('publish：fix 期间分支已被别人更新 → 作废本次修复、不推送、不加 needs-user，评论说明', () => {
  const t = publishSetup();
  const other = join(root, `br-${n++}`);
  execFileSync('git', ['clone', '-q', '-b', 'claude/x', t.remote, other]);
  writeFileSync(join(other, 'c'), '3');
  execFileSync('git', ['-C', other, 'add', 'c']);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'manual fix'], { cwd: other });
  execFileSync('git', ['push', '-q', 'origin', 'claude/x'], { cwd: other });
  const moved = t.ref('refs/heads/claude/x');
  const r = t.run({ MODE: 'fix', EVENT: 'workflow_dispatch' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /published=superseded/);
  assert.equal(t.ref('refs/heads/claude/x'), moved, '不覆盖别人的新提交');
  assert.match(t.gh.log(), /^pr comment 4/m);
  assert.doesNotMatch(t.gh.log(), /needs-user/);
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

test('publish：新分支开出前 main 已更新（含工作流改动）→ 先挪到当前 main 上再推；有冲突则失败且不推送', () => {
  const t = publishSetup({ branch: 'claude/issue-7' });
  // work 运行期间 main 前进了一个改工作流的提交
  const other = join(root, `main-${n++}`);
  execFileSync('git', ['clone', '-q', '-b', 'main', t.remote, other]);
  mkdirSync(join(other, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(other, '.github', 'workflows', 'x.yml'), 'on: push');
  execFileSync('git', ['-C', other, 'add', '.']);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'wf'], { cwd: other });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });
  const main = t.ref('refs/heads/main');
  const r = t.run({ MODE: 'implement', EVENT: 'issues' });
  assert.equal(r.status, 0, r.stderr);
  const tip = t.ref('refs/heads/claude/issue-7');
  assert.equal(t.ref(`${tip}^`), main); // 新提交的父提交是当前 main
  assert.equal(execFileSync('git', ['diff', '--name-only', main, tip], { cwd: t.remote, encoding: 'utf8' }).trim(), 'b'); // 只带新提交自己的改动

  // 冲突：main 改了同一个文件
  const c = publishSetup({ branch: 'claude/issue-8' });
  const o2 = join(root, `main-${n++}`);
  execFileSync('git', ['clone', '-q', '-b', 'main', c.remote, o2]);
  writeFileSync(join(o2, 'b'), 'conflict');
  execFileSync('git', ['-C', o2, 'add', 'b']);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c'], { cwd: o2 });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: o2 });
  assert.notEqual(c.run({ MODE: 'implement', EVENT: 'issues' }).status, 0);
  assert.equal(c.ref('refs/heads/claude/issue-8'), c.start); // 未推送
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

test('publish：停下等人时 @ 仓库所有者（GitHub 才会通知）；DEVLOOP_NOTIFY 为空则不 @，非法登录名不 @', () => {
  for (const [env, want] of [[{ GITHUB_REPOSITORY_OWNER: 'alice' }, '@alice'], [{ GITHUB_REPOSITORY_OWNER: 'alice', DEVLOOP_NOTIFY: 'bob' }, '@bob'], [{ GITHUB_REPOSITORY_OWNER: 'alice', DEVLOOP_NOTIFY: '' }, null], [{ GITHUB_REPOSITORY_OWNER: 'a b;x' }, null]]) {
    const t = publishSetup({ outcome: 'needs-user', withBundle: false });
    const r = t.run({ MODE: 'fix', EVENT: 'issue_comment', DEVLOOP_NOTIFY: undefined, ...env });
    assert.equal(r.status, 0, r.stderr);
    const body = readFileSync(join(t.out, 'body.md'), 'utf8');
    if (want) assert.match(body, new RegExp(`${want} 自动循环已停下`));
    else assert.doesNotMatch(body, /@/);
  }
});

/**
 * 读取 claude.yml 里 publish 任务的真实 `if:` 条件，按 GitHub 表达式语义对给定的 work 结果求值。
 * 只支持当前用到的子集（`&&` 连接的 always()/success()/failure()/cancelled() 与 `needs.work.result ==/!= '值'`）；
 * 遇到不认识的写法直接抛错，让测试失败，而不是默默算错。
 */
function publishRuns(workResult) {
  const yml = readFileSync(join(HERE, '../../.github/workflows/claude.yml'), 'utf8');
  const job = yml.match(/^  publish:\n((?:(?: {4,}.*)?\n)*)/m);
  assert.ok(job, 'claude.yml 里找不到 publish 任务');
  const m = job[1].match(/^ {4}if: *(.+)$/m);
  assert.ok(m && !/^[>|]/.test(m[1]), 'publish 的 if 应为单行表达式');
  const expr = m[1].replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();
  if (/\|\||[()]/.test(expr.replace(/\w+\(\)/g, ''))) throw new Error(`不支持的表达式：${expr}`);
  // 依赖任务结果对状态函数的影响（单一依赖 work）
  const status = { 'always()': true, 'success()': workResult === 'success', 'failure()': workResult === 'failure', 'cancelled()': false };
  let hasStatusFn = false;
  const ok = expr.split('&&').map((s) => s.trim()).every((term) => {
    if (term in status) { hasStatusFn = true; return status[term]; }
    const c = term.match(/^needs\.work\.result *(==|!=) *'([a-z]+)'$/);
    if (!c) throw new Error(`不支持的条件项：${term}`);
    return c[1] === '==' ? workResult === c[2] : workResult !== c[2];
  });
  // 没写状态函数时 GitHub 隐含 success()
  return ok && (hasStatusFn || workResult === 'success');
}

test('claude.yml：work 成功或失败才运行 publish；被取消或跳过不运行（防误报失败、误加 needs-user）', () => {
  assert.equal(publishRuns('success'), true);
  assert.equal(publishRuns('failure'), true);
  assert.equal(publishRuns('cancelled'), false);
  assert.equal(publishRuns('skipped'), false);
});

test('publish：拒绝推送到非 claude/* 分支；implement 时分支已被别人更新（非快进）失败、不覆盖（fix 的情形见“作废本次修复”）', () => {
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
  assert.notEqual(t.run({ MODE: 'implement', EVENT: 'issues' }).status, 0);
  assert.equal(t.ref('refs/heads/claude/x'), theirs);
});

test('ctx：按 issue 手动触发（KIND=issue）→ implement；执行 ctx.sh 里真实的筛选表达式，关闭 / 无 devloop / 带 needs-user / 是 PR 都拒绝', () => {
  const issue = (o = {}) => JSON.stringify({ state: 'OPEN', url: 'https://github.com/o/r/issues/12', labels: [{ name: 'proposal' }, { name: 'devloop' }], ...o });
  const run = (json, N = '12') => runCtx({ EVENT: 'workflow_dispatch', KIND: 'issue', N, FAKE_ISSUE_JSON: json });
  const ok = run(issue());
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.kv, { mode: 'implement', branch: 'claude/issue-12', number: '12' });
  assert.equal(run(issue({ labels: [{ name: 'devloop' }] })).code, 0); // devloop 在第 0 位也认
  const bad = {
    关闭: issue({ state: 'CLOSED' }),
    无devloop: issue({ labels: [{ name: 'proposal' }] }),
    带needs_user: issue({ labels: [{ name: 'devloop' }, { name: 'needs-user' }] }),
    是PR: issue({ url: 'https://github.com/o/r/pull/12' }),
  };
  for (const [k, json] of Object.entries(bad)) assert.notEqual(run(json).code, 0, k);
  assert.notEqual(run(issue(), '12; id').code, 0);
  // 不带 KIND 的手动触发仍是修复 PR
  assert.equal(runCtx({ EVENT: 'workflow_dispatch', N: '4', FAKE_HEAD_REF: 'claude/x' }).kv.mode, 'fix');
});

test('claude.yml：手动触发有 pr / issue 两个可选输入，二选一；编号表达式都含 inputs.issue', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/claude.yml'), 'utf8');
  assert.match(yml, /issue:\n {8}description: .*\n {8}required: false/);
  assert.match(yml, /pr:\n {8}description: .*\n {8}required: false/);
  assert.match(yml, /KIND: \$\{\{ inputs\.issue && 'issue' \|\| '' \}\}/);
  assert.match(yml, /pr 与 issue 只能填一个/);
  assert.doesNotMatch(yml, /github\.event\.issue\.number \|\| inputs\.pr \}\}/);
});

/**
 * install-bun.sh 行为测试：假 npm（按 plan 逐次成功 / 失败，成功时在 PATH 里放一个假 bun）、假 sleep（只记录秒数）。
 * plan 例：'fail,ok'；'ok-broken' 表示 npm 成功但装出的 bun 不能运行。
 */
function runInstallBun(plan) {
  const dir = join(root, `bun-${n++}`);
  const bin = join(dir, 'bin');
  const npmBin = join(dir, 'npm-global');
  mkdirSync(bin, { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(join(dir, 'plan'), plan.split(',').join('\n') + '\n');
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
echo "npm $*" >> "${dir}/log"
step=$(head -n 1 "${dir}/plan"); sed -i.bak 1d "${dir}/plan"
case "$step" in
  ok) printf '#!/usr/bin/env bash\\necho 1.4.4\\n' > "${npmBin}/bun"; chmod +x "${npmBin}/bun"; exit 0 ;;
  ok-broken) printf '#!/usr/bin/env bash\\nexit 3\\n' > "${npmBin}/bun"; chmod +x "${npmBin}/bun"; exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash\necho "sleep $1" >> "${dir}/log"\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', [join(HERE, 'install-bun.sh')], {
    env: { ...process.env, PATH: `${bin}:${npmBin}:/usr/bin:/bin`, GITHUB_OUTPUT: out },
    encoding: 'utf8',
  });
  const log = existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : [];
  return { code: r.status, out: readFileSync(out, 'utf8'), log, npmBin };
}

test('install-bun.sh：首次成功 → 不等待，输出可执行路径', () => {
  const r = runInstallBun('ok');
  assert.equal(r.code, 0);
  assert.deepEqual(r.log, ['npm install -g --no-audit --no-fund bun@1.4.4']);
  assert.equal(r.out, `path=${join(r.npmBin, 'bun')}\n`);
});

test('install-bun.sh：失败后重试成功 → 按 15、30 秒退避，成功即停', () => {
  const r = runInstallBun('fail,fail,ok');
  assert.equal(r.code, 0);
  assert.deepEqual(r.log.filter((l) => l.startsWith('sleep')), ['sleep 15', 'sleep 30']);
  assert.equal(r.log.filter((l) => l.startsWith('npm')).length, 3);
  assert.match(r.out, /^path=.*\/bun\n$/);
});

test('install-bun.sh：连续三次失败（或装出的 bun 不能运行）→ 非零退出、不输出路径（action 不会拿到空路径继续）', () => {
  for (const plan of ['fail,fail,fail', 'ok-broken,ok-broken,ok-broken']) {
    const r = runInstallBun(plan);
    assert.notEqual(r.code, 0, plan);
    assert.equal(r.out, '', plan);
    assert.equal(r.log.filter((l) => l.startsWith('npm')).length, 3, plan);
    assert.deepEqual(r.log.filter((l) => l.startsWith('sleep')), ['sleep 15', 'sleep 30'], plan); // 最后一次失败后不再等待
  }
});

test('claude.yml：action 之前运行 install-bun.sh，并把它输出的路径交给 path_to_bun_executable', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/claude.yml'), 'utf8');
  const bunAt = yml.indexOf('id: bun');
  assert.ok(bunAt > 0 && bunAt < yml.indexOf('uses: anthropics/claude-code-action'));
  assert.match(yml, /id: bun\n(?: {8}#.*\n)* {8}run: bash "\$RUNNER_TEMP\/install-bun\.sh"/);
  // 工作区根目录的检出会清空根目录（含 _devloop）：脚本必须在 _devloop 检出之后、根目录检出之前复制到 RUNNER_TEMP
  const steps = yml.slice(yml.indexOf('  work:'), yml.indexOf('uses: anthropics/claude-code-action'));
  const devloopCheckout = steps.indexOf('path: _devloop');
  const copy = steps.indexOf('cp _devloop/scripts/devloop/install-bun.sh "$RUNNER_TEMP/install-bun.sh"');
  const rootCheckout = steps.indexOf("ref: ${{ steps.ctx.outputs.mode == 'fix'");
  assert.ok(devloopCheckout > 0 && devloopCheckout < copy && copy < rootCheckout && rootCheckout < steps.indexOf('id: bun'), '顺序须为：检出 _devloop → 复制脚本 → 检出根目录 → 运行脚本');
  assert.doesNotMatch(steps.slice(rootCheckout), /_devloop\//, '根目录检出之后不能再引用 _devloop');
  assert.match(yml, /path_to_bun_executable: \$\{\{ steps\.bun\.outputs\.path \}\}/);
});

test('claude.yml：只在手动触发（云端审核用 GITHUB_TOKEN 发起）时放行 github-actions 机器人', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/claude.yml'), 'utf8');
  assert.match(yml, /\n {10}allowed_bots: \$\{\{ github\.event_name == 'workflow_dispatch' && 'github-actions' \|\| '' \}\}\n/);
  assert.doesNotMatch(yml, /allowed_bots: ['"]?\*/);
});

test('ctx / publish：GPT 执行者（PREFIX=codex）只动 codex/* 分支，按 issue 触发要求 gpt-design 标签；未知前缀拒绝', () => {
  assert.deepEqual(runCtx({ EVENT: 'issues', N: '9', PREFIX: 'codex' }).kv, { mode: 'implement', branch: 'codex/issue-9', number: '9' });
  assert.deepEqual(runCtx({ EVENT: 'workflow_dispatch', N: '4', PREFIX: 'codex', FAKE_HEAD_REF: 'codex/m2-dash' }).kv, { mode: 'fix', branch: 'codex/m2-dash', number: '4' });
  assert.notEqual(runCtx({ EVENT: 'workflow_dispatch', N: '4', PREFIX: 'codex', FAKE_HEAD_REF: 'claude/x' }).code, 0, 'GPT 不修 Claude 的分支');
  assert.notEqual(runCtx({ EVENT: 'workflow_dispatch', N: '4', FAKE_HEAD_REF: 'codex/x' }).code, 0, 'Claude 不修 GPT 的分支');
  const issue = (labels) => JSON.stringify({ state: 'OPEN', url: 'https://github.com/o/r/issues/9', labels: labels.map((name) => ({ name })) });
  const disp = (labels) => runCtx({ EVENT: 'workflow_dispatch', KIND: 'issue', N: '9', PREFIX: 'codex', LABEL: 'gpt-design', FAKE_ISSUE_JSON: issue(labels) });
  assert.equal(disp(['gpt-design']).kv.branch, 'codex/issue-9');
  assert.notEqual(disp(['devloop']).code, 0, '没有 gpt-design 不接');
  assert.notEqual(runCtx({ EVENT: 'issues', N: '9', PREFIX: 'x' }).code, 0);
  assert.notEqual(runCtx({ EVENT: 'issues', N: '9', LABEL: 'any' }).code, 0);
  const t = publishSetup();
  const r = t.run({ MODE: 'fix', EVENT: 'workflow_dispatch', PREFIX: 'codex' });
  assert.notEqual(r.status, 0, 'PREFIX=codex 时拒绝推 claude/* 分支');
  assert.match(r.stderr, /拒绝推送到非 codex\/\* 分支/);
});

test('codex.yml / claude.yml：读 issue 与 PR 只用 gh … --json（不带 --json 会查只读令牌无权读的 statusCheckRollup）', () => {
  for (const f of ['codex.yml', 'claude.yml']) {
    const yml = readFileSync(join(HERE, `../../.github/workflows/${f}`), 'utf8');
    const views = yml.split('\n').filter((l) => /gh (pr|issue) view/.test(l) && !l.trim().startsWith('#'));
    assert.ok(views.length >= 2, f);
    for (const l of views) assert.match(l, /--json/, `${f}: ${l.trim()}`);
  }
});

test('codex.yml：执行代码的任务只读、GPT 经 main 上的 gpt-agent 只改工作区、跑测试的步骤不持有 key、固定 runner 镜像；发布任务不运行模型', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/codex.yml'), 'utf8');
  const work = yml.slice(yml.indexOf('\n  work:'), yml.indexOf('\n  gate:'));
  const gate = yml.slice(yml.indexOf('\n  gate:'), yml.indexOf('\n  publish:'));
  const pub = yml.slice(yml.indexOf('\n  publish:'));
  assert.match(work, /permissions:\n {6}contents: read\n {6}issues: read\n {6}pull-requests: read\n {6}actions: read\n/);
  assert.doesNotMatch(work, /: write/);
  assert.match(work, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(work, /uses: openai\/codex-action/);
  // 运行的是 main 上的 gpt-agent.mjs（先从 _devloop 复制出来），不是待修分支上的
  assert.match(work, /cp _devloop\/scripts\/devloop\/gpt-agent\.mjs "\$RUNNER_TEMP\/gpt-agent\.mjs"/);
  assert.match(work, /node "\$RUNNER_TEMP\/gpt-agent\.mjs" --mode write /);
  const steps = work.split('\n      - ');
  const keyed = steps.map((x, i) => (/OPENAI_API_KEY/.test(x) ? i : -1)).filter((i) => i >= 0);
  assert.equal(keyed.length, 1, '只有一个步骤持有 key');
  assert.match(steps[keyed[0]], /gpt-agent\.mjs" --mode write/);
  // work 不运行任何仓库代码（Codex 审核 #76 P1；GPT 审核 #76：安装脚本不能改写尚未消费的结论）
  assert.doesNotMatch(work, /npm ci --no-audit|npm test &&|npm run build\)/);
  // 结论在 work 里当场消费，经 job 输出交给 gate / publish
  assert.match(work, /outcome: \$\{\{ steps\.take\.outputs\.outcome \}\}/);
  assert.match(work, /echo outcome=pr >> "\$GITHUB_OUTPUT"/);
  // gate：没有 key、只读令牌，只在结论是 pr 时运行，取 work 的 bundle 再安装与测试
  assert.doesNotMatch(gate, /secrets\.|OPENAI|: write/);
  assert.match(gate, /permissions:\n {6}contents: read\n {4}steps:/);
  assert.match(gate, /if: always\(\) && needs\.work\.outputs\.outcome == 'pr'/);
  assert.match(gate, /work\.bundle" HEAD && git checkout -q --detach FETCH_HEAD/);
  assert.match(gate, /npm ci --no-audit --no-fund && npm test && npm run build/);
  // publish：把关没通过就转 needs-user，丢掉 bundle
  assert.match(pub, /needs: \[work, gate\]/);
  assert.match(pub, /stop\(\) \{[^\n]*echo needs-user > out\/outcome; rm -f out\/work\.bundle; \}/);
  // 产物绑定 work 的尝试号（重跑不取旧产物），gate 核对提交
  assert.match(work, /name: devloop-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(gate, /name: devloop-\$\{\{ github\.run_id \}\}-\$\{\{ needs\.work\.outputs\.attempt \}\}/);
  assert.match(pub, /name: devloop-\$\{\{ github\.run_id \}\}-\$\{\{ needs\.work\.outputs\.attempt \}\}/);
  assert.match(gate, /"\$\(git rev-parse HEAD\)" = "\$HEAD_SHA" \] \|\| \{/);
  assert.ok(pub.indexOf('合并把关结果') < pub.indexOf('publish.sh'));
  assert.match(work, /\^\\\.github\/workflows\//, '改了工作流的结果不发布');
  assert.match(work, /PREFIX: codex\n {10}LABEL: gpt-design/);
  assert.doesNotMatch(pub, /codex-action|claude-code-action|npm /);
  assert.match(pub, /PREFIX: codex/);
  assert.match(yml, /github\.event\.label\.name == 'gpt-design'/);
});

test('codex.yml publish「合并把关结果」：只有 work 成功、结论一致、为 pr、bundle 提交对得上、gate 成功才保留 bundle，其余一律 needs-user', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/codex.yml'), 'utf8');
  const step = yml.slice(yml.indexOf('- name: 合并把关结果'));
  const body = step.slice(step.indexOf('run: |\n') + 7).split('\n');
  const script = body.slice(0, body.findIndex((l) => l !== '' && !l.startsWith('          '))).map((l) => l.slice(10)).join('\n');
  // 一个真实的 bundle，HEAD 是 sha
  const src = mkdtempSync(join(tmpdir(), 'bsrc-'));
  const git = (...a) => execFileSync('git', ['-C', src, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const sha = git('rev-parse', 'HEAD');
  git('bundle', 'create', join(src, 'b.bundle'), 'HEAD');
  const runIt = (env, { file = env.WORK_OUTCOME, log } = {}) => {
    const d = mkdtempSync(join(tmpdir(), 'gate-'));
    mkdirSync(join(d, 'out'));
    if (file !== null) writeFileSync(join(d, 'out/outcome'), `${file}\n`);
    writeFileSync(join(d, 'out/body.md'), 'GPT 的说明');
    writeFileSync(join(d, 'out/work.bundle'), readFileSync(join(src, 'b.bundle')));
    if (log) {
      mkdirSync(join(d, 'gate'));
      writeFileSync(join(d, 'gate/gate.log'), log);
    }
    const r = spawnSync('bash', ['-c', script], { cwd: d, env: { ...process.env, RUN_URL: 'U', WORK_RESULT: 'success', WORK_HEAD: sha, ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { outcome: readFileSync(join(d, 'out/outcome'), 'utf8').trim(), body: readFileSync(join(d, 'out/body.md'), 'utf8'), bundle: existsSync(join(d, 'out/work.bundle')) };
  };
  const needsUser = (r) => assert.ok(r.outcome === 'needs-user' && !r.bundle, JSON.stringify(r));
  assert.deepEqual(runIt({ WORK_OUTCOME: 'pr', GATE: 'success' }), { outcome: 'pr', body: 'GPT 的说明', bundle: true });
  const failed = runIt({ WORK_OUTCOME: 'pr', GATE: 'failure' }, { log: 'npm ERR! 测试失败' });
  needsUser(failed);
  assert.match(failed.body, /把关结果：failure[\s\S]*npm ERR! 测试失败/);
  needsUser(runIt({ WORK_OUTCOME: 'pr', GATE: 'cancelled' }));
  // 结论本就是 needs-user：保留说明，丢 bundle
  const nu = runIt({ WORK_OUTCOME: 'needs-user', GATE: 'skipped' });
  assert.deepEqual(nu, { outcome: 'needs-user', body: 'GPT 的说明', bundle: false });
  // 重跑取到旧产物：产物写着 pr，本次 work 结论 needs-user、gate 跳过 → 不发布
  needsUser(runIt({ WORK_OUTCOME: 'needs-user', GATE: 'skipped' }, { file: 'pr' }));
  // work 失败 / 没有输出 / 没有产物
  needsUser(runIt({ WORK_RESULT: 'failure', WORK_OUTCOME: 'pr', GATE: 'success' }));
  needsUser(runIt({ WORK_OUTCOME: '', GATE: 'skipped' }, { file: 'pr' }));
  needsUser(runIt({ WORK_OUTCOME: 'pr', GATE: 'success' }, { file: null }));
  // bundle 的提交与 work 输出不一致
  needsUser(runIt({ WORK_OUTCOME: 'pr', GATE: 'success', WORK_HEAD: '0'.repeat(40) }));
  needsUser(runIt({ WORK_OUTCOME: 'pr', GATE: 'success', WORK_HEAD: '' }));
});
