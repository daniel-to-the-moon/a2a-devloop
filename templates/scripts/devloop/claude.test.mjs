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
function runInstallBun(plan, { staleOnPath } = {}) {
  const dir = join(root, `bun-${n++}`);
  const bin = join(dir, 'bin');
  const prefix = join(dir, 'npm-prefix');
  const npmBin = join(prefix, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(join(dir, 'plan'), plan.split(',').join('\n') + '\n');
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
if [ "$1" = prefix ]; then echo "${prefix}"; exit 0; fi
echo "npm $*" >> "${dir}/log"
step=$(head -n 1 "${dir}/plan"); sed -i.bak 1d "${dir}/plan"
case "$step" in
  ok) printf '#!/usr/bin/env bash\\necho 1.4.4\\n' > "${npmBin}/bun"; chmod +x "${npmBin}/bun"; exit 0 ;;
  ok-old) printf '#!/usr/bin/env bash\\necho 1.3.0\\n' > "${npmBin}/bun"; chmod +x "${npmBin}/bun"; exit 0 ;;
  ok-broken) printf '#!/usr/bin/env bash\\nexit 3\\n' > "${npmBin}/bun"; chmod +x "${npmBin}/bun"; exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  if (staleOnPath) {
    // 旧版 bun 留在 PATH 上：脚本不得把它当成本次安装的结果
    writeFileSync(join(bin, 'bun'), '#!/usr/bin/env bash\necho 1.4.4\n');
    chmodSync(join(bin, 'bun'), 0o755);
  }
  writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash\necho "sleep $1" >> "${dir}/log"\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const r = spawnSync('bash', [join(HERE, 'install-bun.sh')], {
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: out },
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

test('install-bun.sh：装出的版本与 BUN_VERSION 不符 → 失败、不输出路径', () => {
  const r = runInstallBun('ok-old,ok-old,ok-old');
  assert.notEqual(r.code, 0);
  assert.equal(r.out, '');
});

test('install-bun.sh：npm 没装成、PATH 上却有 bun → 不采用 PATH 上的，失败且不输出路径', () => {
  const r = runInstallBun('fail,fail,fail', { staleOnPath: true });
  assert.notEqual(r.code, 0);
  assert.equal(r.out, '');
});

test('install-bun.sh：路径来自 npm 全局前缀，而非 PATH 上排在前面的另一个 bun', () => {
  const r = runInstallBun('ok', { staleOnPath: true });
  assert.equal(r.code, 0);
  assert.equal(r.out, `path=${join(r.npmBin, 'bun')}\n`);
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

/**
 * 读取 claude.yml 里 work 任务的真实 `if:`（多行 `>-`），用一个小型 GitHub 表达式求值器计算。
 * 支持：&& || ! 括号、== !=、'字符串'、属性路径（含 `.*.name` 过滤）、contains()、startsWith()。
 * 不认识的语法直接抛错，测试失败而不是默默算错。
 */
function workRuns(ctx) {
  const yml = readFileSync(join(HERE, '../../.github/workflows/claude.yml'), 'utf8');
  const job = yml.match(/^  work:\n((?:(?: {4,}.*)?\n)*)/m);
  assert.ok(job, 'claude.yml 里找不到 work 任务');
  const m = job[1].match(/^ {4}if: >-\n((?: {6,}.*\n)+)/m);
  assert.ok(m, 'work 的 if 应为 >- 多行表达式');
  const src = m[1].split('\n').map((l) => l.trim()).join(' ');
  const tokens = src.match(/'[^']*'|&&|\|\||==|!=|!|\(|\)|,|[A-Za-z_][\w.*-]*/g);
  assert.equal(tokens.join('').replace(/\s/g, ''), src.replace(/\s/g, ''), '表达式里有不认识的字符');
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const lookup = (path) => {
    let cur = [ctx];
    for (const part of path.split('.')) {
      if (part === '*') { cur = cur.flatMap((v) => (Array.isArray(v) ? v : [])); continue; }
      cur = cur.map((v) => (v == null ? null : v[part]));
    }
    return path.includes('*') ? cur.filter((v) => v != null) : cur[0] ?? null;
  };
  const eq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  function primary() {
    const t = next();
    if (t === '(') { const v = or(); assert.equal(next(), ')'); return v; }
    if (t === '!') return !primary();
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t === 'contains' || t === 'startsWith') {
      assert.equal(next(), '(');
      const a = or(); assert.equal(next(), ',');
      const b = or(); assert.equal(next(), ')');
      if (t === 'startsWith') return String(a ?? '').startsWith(String(b));
      return Array.isArray(a) ? a.some((x) => eq(x, b)) : String(a ?? '').includes(String(b));
    }
    if (/^[A-Za-z_]/.test(t)) return lookup(t);
    throw new Error(`不支持的记号：${t}`);
  }
  function cmp() {
    let v = primary();
    while (peek() === '==' || peek() === '!=') { const op = next(); const r = primary(); v = op === '==' ? eq(v, r) : !eq(v, r); }
    return v;
  }
  function and() { let v = cmp(); while (peek() === '&&') { next(); const r = cmp(); v = Boolean(v) && Boolean(r); } return v; }
  function or() { let v = and(); while (peek() === '||') { next(); const r = and(); v = Boolean(v) || Boolean(r); } return v; }
  const result = or();
  assert.equal(i, tokens.length, '表达式未完整解析');
  return Boolean(result);
}

const labelled = (vars = {}, labels = []) => ({
  github: { event_name: 'issues', repository_owner: 'o', event: { label: { name: 'devloop' }, issue: { labels: labels.map((name) => ({ name })) } } },
  vars,
});
const reviewComment = (vars = {}) => ({
  github: {
    event_name: 'issue_comment',
    repository_owner: 'o',
    event: { issue: { pull_request: { url: 'x' }, labels: [] }, comment: { user: { login: 'o' }, body: '执行者：GPT 审核 <!-- devloop state=changes:f2 sig=x -->' } },
  },
  vars,
});

test('claude.yml：打 devloop 标签触发；DEVLOOP_PAUSED=true 时一切不跑；needs-user 不跑', () => {
  assert.equal(workRuns(labelled()), true);
  assert.equal(workRuns(labelled({ DEVLOOP_PAUSED: 'true' })), false);
  assert.equal(workRuns(labelled({}, ['needs-user'])), false);
  assert.equal(workRuns({ github: { event_name: 'workflow_dispatch', event: {} }, vars: { DEVLOOP_PAUSED: 'true' } }), false);
  assert.equal(workRuns({ github: { event_name: 'workflow_dispatch', event: {} }, vars: {} }), true);
});

test('claude.yml：审核评论默认触发修复；DEVLOOP_REVIEWER=off 或暂停时不触发；普通评论不触发', () => {
  assert.equal(workRuns(reviewComment()), true);
  assert.equal(workRuns(reviewComment({ DEVLOOP_REVIEWER: 'off' })), false);
  assert.equal(workRuns(reviewComment({ DEVLOOP_PAUSED: 'true' })), false);
  const ordinary = reviewComment();
  ordinary.github.event.comment.body = '执行者：GPT 看起来不错';
  assert.equal(workRuns(ordinary), false);
  const stranger = reviewComment();
  stranger.github.event.comment.user.login = 'someone-else';
  assert.equal(workRuns(stranger), false);
});

/** dispatch-review.sh：假 gh 记录参数；pr list 输出 FAKE_PR_NUM */
function runDispatch({ outcome = 'pr', mode = 'new', N = '7', pr = '12', ghExit = 0 }) {
  const dir = join(root, `disp-${n++}`);
  const bin = join(dir, 'bin');
  const out = join(dir, 'out');
  mkdirSync(bin, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'outcome'), outcome + '\n');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/log"\nif [ "$1 $2" = "pr list" ]; then printf '%s' "${pr}"; exit 0; fi\nexit ${ghExit}\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const r = spawnSync('bash', [join(HERE, 'dispatch-review.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUT: out, REPO: 'o/r', N, MODE: mode, BRANCH: 'claude/issue-7' },
    encoding: 'utf8',
  });
  const log = existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : [];
  return { code: r.status, log };
}

test('dispatch-review.sh：新 PR → 查出编号后只触发该 PR 的审核', () => {
  const r = runDispatch({ mode: 'new', pr: '12' });
  assert.equal(r.code, 0);
  assert.equal(r.log.at(-1), 'workflow run gpt-review.yml -R o/r --ref main -f pr=12');
});

test('dispatch-review.sh：修复模式直接用 N，不查 PR 列表', () => {
  const r = runDispatch({ mode: 'fix', N: '9' });
  assert.deepEqual(r.log, ['workflow run gpt-review.yml -R o/r --ref main -f pr=9']);
});

test('dispatch-review.sh：没有推送（outcome 不是 pr）或查不到 PR 编号 → 不触发', () => {
  assert.deepEqual(runDispatch({ outcome: 'needs-user' }).log, []);
  const r = runDispatch({ mode: 'new', pr: '' });
  assert.equal(r.code, 0);
  assert.ok(!r.log.some((l) => l.startsWith('workflow run')));
});

test('dispatch-review.sh：触发失败也退出 0（不让发布步骤变红）', () => {
  assert.equal(runDispatch({ mode: 'fix', ghExit: 1 }).code, 0);
});

test('claude.yml：publish 的触发步骤受 CLOUD_REVIEW 控制、continue-on-error、位于发布步骤之后；actions: write 只给 publish', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/claude.yml'), 'utf8');
  const pub = yml.slice(yml.indexOf('\n  publish:'));
  assert.match(pub, /actions: write/);
  assert.doesNotMatch(yml.slice(0, yml.indexOf('\n  publish:')), /actions: write/);
  const step = pub.slice(pub.indexOf('- name: 触发云端审核'));
  assert.match(step.split('- name:')[1] ? step.slice(0, 600) : step, /if: vars\.CLOUD_REVIEW == 'on'\n\s+continue-on-error: true/);
  assert.ok(pub.indexOf('推送分支并开 PR 或评论') < pub.indexOf('触发云端审核') && pub.indexOf('触发云端审核') < pub.indexOf('发布失败时报告'));
  assert.match(pub, /run: bash _devloop\/scripts\/devloop\/dispatch-review\.sh/);
});
