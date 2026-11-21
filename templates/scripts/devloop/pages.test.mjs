// ci.yml pages 任务的行为测试：假 Cloudflare API（本地 HTTP 服务）+ 假 gh / wrangler；并读取真实 YAML 检查任务门控
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const SCHEMA_FIXTURE = `-- 内置副本
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, aid TEXT NOT NULL, ev TEXT NOT NULL, day INTEGER NOT NULL, ts INTEGER NOT NULL, v TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_day ON events (day);
CREATE INDEX IF NOT EXISTS events_aid ON events (aid, day);
`;
/** 可选模块的文件没装时跳过对应测试（只装核心循环时 CI 不会因 ENOENT 失败） */
const optionalMissing = (p) => (existsSync(join(HERE, '../..', p)) ? false : `${p} 未安装（可选模块），跳过`);
const root = mkdtempSync(join(tmpdir(), 'devloop-pages-'));
const ACCOUNT = 'acc123';

/** 假 Cloudflare API：projects 为已存在的项目；createFails 时创建返回错误；记录请求 */
let state;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    state.calls.push(`${req.method} ${req.url}`);
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!req.url.startsWith('/accounts/')) {
      // 假的 pages.dev 站点：按 Host 判断是否被 Access 保护
      const host = (req.headers.host || '').split(':')[0];
      const mode = state.access[host] ?? state.access['*'] ?? 'open';
      if (mode === 'redirect') { res.writeHead(302, { location: `https://team.cloudflareaccess.com/cdn-cgi/access/login/${host}?kid=k&redirect_url=%2F` }); return res.end(); }
      if (mode === 'forbidden') { res.writeHead(403); return res.end('Browser Integrity Check'); }
      if (mode === 'unauthorized') { res.writeHead(401); return res.end(); }
      if (mode.startsWith('to:')) { res.writeHead(302, { location: mode.slice(3) }); return res.end(); }
      res.writeHead(200); return res.end('<html>');
    }
    // 假 D1：state.d1 为 { dbs: [{name, uuid}], listFails, queryFails, queries: [] }
    const d = req.url.match(/^\/accounts\/([^/]+)\/d1\/database(?:\/([^/?]+)\/query)?(?:\?(.*))?$/);
    if (d) {
      if (d[1] !== ACCOUNT || req.headers.authorization !== 'Bearer tok' || state.d1.listFails) return send(403, { success: false, errors: [{ message: 'no D1 permission' }] });
      if (req.method === 'GET' && !d[2]) {
        const name = new URLSearchParams(d[3] ?? '').get('name') ?? '';
        // 与真实 API 一样按名字模糊匹配：返回包含该名字的所有库
        return send(200, { success: true, result: state.d1.dbs.filter((x) => x.name.includes(name)) });
      }
      if (req.method === 'POST' && !d[2]) {
        const { name } = JSON.parse(body);
        const db = { name, uuid: '0000aaaa-bbbb-4ccc-8ddd-eeeeffff0001' };
        state.d1.dbs.push(db);
        return send(200, { success: true, result: db });
      }
      if (req.method === 'POST' && d[2]) {
        if (state.d1.queryFails) return send(400, { success: false, errors: [{ message: 'bad sql' }] });
        state.d1.queries.push({ db: d[2], ...JSON.parse(body) });
        return send(200, { success: true, result: [{ success: true }] });
      }
      return send(405, { success: false });
    }
    const m = req.url.match(/^\/accounts\/([^/]+)\/pages\/projects(?:\/([^/]+))?$/);
    if (!m || m[1] !== ACCOUNT || req.headers.authorization !== 'Bearer tok') return send(403, { success: false, errors: [{ message: 'forbidden' }] });
    if (req.method === 'GET' && m[2]) {
      const p = state.projects.find((x) => x === m[2]); // 精确按名字
      return p ? send(200, { success: true, result: { name: p, subdomain: `${p}.pages.dev` } }) : send(404, { success: false, errors: [{ message: 'not found' }] });
    }
    if (req.method === 'POST' && !m[2]) {
      if (state.createFails) return send(400, { success: false, errors: [{ message: 'name taken' }] });
      const { name } = JSON.parse(body);
      state.projects.push(name);
      return send(200, { success: true, result: { name, subdomain: `${name}-x1.pages.dev` } });
    }
    send(405, { success: false });
  });
});
let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function setup({ projects = [], createFails = false, latest = 'sha1', dist = true, access = { '*': 'redirect' }, d1 = {} } = {}) {
  state = { projects: [...projects], createFails, calls: [], access, d1: { dbs: [], queries: [], ...d1 } };
  const dir = join(root, `c${n++}`);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\nprintf '%s' "${latest}"\n`);
  // 假 wrangler：记录参数、工作目录里的 wrangler.toml 与 functions 文件
  writeFileSync(
    join(bin, 'wrangler'),
    `#!/usr/bin/env bash\necho "$*" >> "${dir}/wrangler.log"\n[ -f wrangler.toml ] && cp wrangler.toml "${dir}/deployed.toml"\n[ -f functions/api/ev.js ] && echo yes > "${dir}/deployed-functions"\n[ -f functions/schema.sql ] && echo yes > "${dir}/deployed-schema"\n[ -f "$3/index.html" ] && echo yes > "${dir}/deployed-dist"\nexit 0\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'wrangler'), 0o755);
  const distDir = join(dir, 'dist');
  mkdirSync(distDir);
  if (dist) writeFileSync(join(distDir, 'index.html'), '<html>');
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  const run = (env = {}, script = 'pages.sh') =>
    new Promise((resolve) => {
      const p = spawn('bash', [join(HERE, script)], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CLOUDFLARE_API_TOKEN: 'tok',
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          PROJECT: 'my-app',
          SHA: 'sha1',
          DIST: distDir,
          REPO: 'o/r',
          WRANGLER: join(bin, 'wrangler'),
          CF_API: base,
          ACCESS_CHECK_SCHEME: 'http',
          ACCESS_CHECK_CONNECT: base.replace('http://', ''),
          SUMMARY: join(dir, 'summary.md'),
          ...env,
        },
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => resolve({ code, out, err }));
    });
  const fdir = join(dir, 'functions');
  mkdirSync(join(fdir, 'api'), { recursive: true });
  writeFileSync(join(fdir, 'api', 'ev.js'), '// ev');
  // 装了统计模块就用真实表结构；只装核心循环时用同结构的内置副本（pages.sh 本身仍被完整测试）
  const realSchema = join(HERE, '../../functions/schema.sql');
  writeFileSync(join(fdir, 'schema.sql'), existsSync(realSchema) ? readFileSync(realSchema, 'utf8') : SCHEMA_FIXTURE);
  return { run, wrangler: () => read('wrangler.log'), summary: () => read('summary.md'), read, fdir };
}

test('缺凭据：明确失败', async () => {
  const t = setup({ projects: ['my-app'] });
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    const r = await t.run({ [k]: '' });
    assert.notEqual(r.code, 0);
    assert.match(r.err, new RegExp(k));
  }
});

test('项目已存在：精确取到地址，不创建；开关关闭时不上传', async () => {
  const t = setup({ projects: ['my-app'] });
  const r = await t.run({ DEPLOY: '' });
  assert.equal(r.code, 0, r.err);
  assert.match(t.summary(), /https:\/\/my-app\.pages\.dev/);
  assert.ok(!state.calls.some((c) => c.startsWith('POST')));
  assert.equal(t.wrangler(), '');
});

test('项目不存在：创建后用 Cloudflare 返回的实际地址（可能带后缀）', async () => {
  const t = setup();
  const r = await t.run({ DEPLOY: '' });
  assert.equal(r.code, 0, r.err);
  assert.match(t.summary(), /https:\/\/my-app-x1\.pages\.dev/);
});

test('只有同前缀的其他项目、目标创建失败：失败并保留错误，不误用别的项目地址', async () => {
  const t = setup({ projects: ['my-app-staging'], createFails: true });
  const r = await t.run({ DEPLOY: 'true' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /name taken/);
  assert.doesNotMatch(t.summary(), /my-app-staging/);
  assert.equal(t.wrangler(), '');
});

test('开关开启且是 main 最新提交：上传正确的产物目录与提交号', async () => {
  const t = setup({ projects: ['my-app'], latest: 'sha1' });
  const r = await t.run({ DEPLOY: 'true' });
  assert.equal(r.code, 0, r.err);
  assert.match(t.wrangler(), /^pages deploy \S+\/dist --project-name my-app --branch main --commit-hash sha1 /m);
});

test('Access 兜底：只有重定向到 https://<团队>.cloudflareaccess.com/cdn-cgi/access/login 才算受保护', async () => {
  const refuse = [
    { '*': 'open' },
    { '*': 'forbidden' }, // 反机器人 403：不能证明有 Access
    { '*': 'unauthorized' },
    { '*': 'to:https://example.com/' },
    { '*': 'to:https://evil.com/?next=team.cloudflareaccess.com/cdn-cgi/access/login' },
    { '*': 'to:http://team.cloudflareaccess.com/cdn-cgi/access/login' }, // 非 https
    { '*': 'to:https://team.cloudflareaccess.com.evil.com/cdn-cgi/access/login' }, // 主机后缀伪装
    { '*': 'to:https://cloudflareaccess.com/cdn-cgi/access/login' }, // 缺团队子域
    { '*': 'to:https://team.cloudflareaccess.com/other' }, // 路径不对
    { '*': 'to:https://team.cloudflareaccess.com/cdn-cgi/access/loginx' },
    { 'my-app.pages.dev': 'redirect', '*': 'open' }, // 只保护了正式地址
    { 'my-app.pages.dev': 'open', '*': 'redirect' }, // 只保护了预览地址
  ];
  for (const access of refuse) {
    const t = setup({ projects: ['my-app'], access });
    const r = await t.run({ DEPLOY: 'true' });
    assert.notEqual(r.code, 0, JSON.stringify(access));
    assert.match(r.err, /未确认受 Cloudflare Access 保护/);
    assert.equal(t.wrangler(), '', JSON.stringify(access));
  }
  const ok = setup({ projects: ['my-app'], access: { '*': 'redirect' } });
  assert.equal((await ok.run({ DEPLOY: 'true' })).code, 0);
  assert.notEqual(ok.wrangler(), '');
});

test('过期运行（main 已有更新的提交，含历史重跑与逆序完成）：跳过上传', async () => {
  const t = setup({ projects: ['my-app'], latest: 'sha2' });
  const r = await t.run({ DEPLOY: 'true', SHA: 'sha1' });
  assert.equal(r.code, 0, r.err);
  assert.equal(t.wrangler(), '');
  assert.match(t.summary(), /已不是 main 最新/);
});

test('产物不完整：失败，不上传', async () => {
  const t = setup({ projects: ['my-app'], dist: false });
  const r = await t.run({ DEPLOY: 'true' });
  assert.notEqual(r.code, 0);
  assert.equal(t.wrangler(), '');
});

test('项目名非法（防注入）：失败', async () => {
  const t = setup({ projects: ['my-app'] });
  for (const PROJECT of ['', 'Camp', 'a b', 'x;rm -rf /', '../x']) assert.notEqual((await t.run({ PROJECT })).code, 0, PROJECT);
});

test('ci.yml：pages 任务只在 main 上（push 或 deploy_main 触发）运行、串行且保留全部排队（queue: max），并调用 pages.sh', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/ci.yml'), 'utf8');
  const job = yml.match(/^  pages:\n((?:(?: {4,}.*)?\n)*)/m);
  assert.ok(job, 'ci.yml 里找不到 pages 任务');
  const body = job[1];
  assert.match(body, /^ {4}if: vars\.PAGES_PROJECT != '' && github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.deploy_main == 'true'\)\)$/m);
  assert.match(body, /^ {4}concurrency:\n {6}group: pages-deploy\n {6}cancel-in-progress: false\n {6}queue: max$/m);
  assert.match(body, /bash _devloop\/scripts\/devloop\/pages\.sh/);
  assert.match(body, /DEPLOY: \$\{\{ vars\.PAGES_DEPLOY \}\}/);
});

test('公开发布（PUBLIC=true）：正式地址不要求 Access 也上传；未设置时仍拒绝未保护的地址', async () => {
  const pub = setup({ projects: ['my-app'], access: { 'my-app.pages.dev': 'open', '*': 'redirect' } });
  const r = await pub.run({ DEPLOY: 'true', PUBLIC: 'true' });
  assert.equal(r.code, 0, r.err);
  assert.match(pub.wrangler(), /pages deploy/);
  assert.match(pub.summary(), /公开发布/);
  // 公开模式下预览地址仍须受保护：通配符被误删时拒绝上传
  for (const access of [{ '*': 'open' }, { 'my-app.pages.dev': 'open', '*': 'forbidden' }]) {
    const t = setup({ projects: ['my-app'], access });
    const bad = await t.run({ DEPLOY: 'true', PUBLIC: 'true' });
    assert.notEqual(bad.code, 0, JSON.stringify(access));
    assert.match(bad.err, /预览地址/);
    assert.equal(t.wrangler(), '', JSON.stringify(access));
  }
  for (const PUBLIC of ['', 'false', 'TRUE', 'yes']) {
    const t = setup({ projects: ['my-app'], access: { '*': 'open' } });
    assert.notEqual((await t.run({ DEPLOY: 'true', PUBLIC })).code, 0, PUBLIC);
    assert.equal(t.wrangler(), '', PUBLIC);
  }
});

test('匿名统计（ANALYTICS=on）：没有库就创建，逐条建表、清理过期记录，带 D1 绑定与 functions 发布', async () => {
  const t = setup({ projects: ['my-app'], d1: { dbs: [{ name: 'my-app-analytics-old', uuid: '9999' }] } });
  const r = await t.run({ DEPLOY: 'true', ANALYTICS: 'on', FUNCTIONS_DIR: t.fdir, RETENTION_DAYS: '180' });
  assert.equal(r.code, 0, r.err);
  assert.equal(state.d1.dbs.length, 2, '同前缀的其他库不能被误用，应新建');
  const id = '0000aaaa-bbbb-4ccc-8ddd-eeeeffff0001';
  const sqls = state.d1.queries.map((q) => q.sql);
  assert.ok(state.d1.queries.every((q) => q.db === id));
  assert.equal(sqls.filter((x) => /^(-- .*\n)?CREATE (TABLE|INDEX) IF NOT EXISTS/.test(x)).length, 3, sqls.join('\n---\n'));
  const del = state.d1.queries.at(-1);
  assert.equal(del.sql, 'DELETE FROM events WHERE ts < ?1');
  const cutoff = del.params[0];
  const expect = Date.now() - 180 * 86400000;
  assert.ok(Math.abs(cutoff - expect) < 120000, `cutoff ${cutoff} vs ${expect}`);
  const toml = t.read('deployed.toml');
  assert.match(toml, /binding = "DB"/);
  assert.match(toml, new RegExp(`database_id = "${id}"`));
  assert.match(toml, /database_name = "my-app-analytics"/);
  assert.equal(t.read('deployed-functions').trim(), 'yes');
  assert.equal(t.read('deployed-schema'), '', 'schema.sql 不随站点发布');
  assert.equal(t.read('deployed-dist').trim(), 'yes');
  assert.match(t.wrangler(), /^pages deploy dist --project-name my-app --branch main --commit-hash sha1 /m);
});

test('匿名统计：已有同名库直接复用，不重复创建', async () => {
  const t = setup({ projects: ['my-app'], d1: { dbs: [{ name: 'my-app-analytics', uuid: '1111aaaa-bbbb-4ccc-8ddd-eeeeffff0002' }] } });
  const r = await t.run({ DEPLOY: 'true', ANALYTICS: 'on', FUNCTIONS_DIR: t.fdir });
  assert.equal(r.code, 0, r.err);
  assert.equal(state.d1.dbs.length, 1);
  assert.match(t.read('deployed.toml'), /database_id = "1111aaaa-bbbb-4ccc-8ddd-eeeeffff0002"/);
});

test('匿名统计：缺 D1 权限、SQL 失败、缺 functions、保留天数非法，都失败且不上传', async () => {
  const cases = [
    [{ d1: { listFails: true } }, {}, /D1 → Edit/],
    [{ d1: { queryFails: true } }, {}, /D1 执行失败/],
    [{}, { FUNCTIONS_DIR: '/nonexistent' }, /缺少 functions/],
    [{}, { RETENTION_DAYS: '1;rm' }, /RETENTION_DAYS/],
    // 隐私说明承诺 180 天：只能改短
    [{}, { RETENTION_DAYS: '181' }, /180/],
    [{}, { RETENTION_DAYS: '0' }, /RETENTION_DAYS/],
  ];
  for (const [opt, env, re] of cases) {
    const t = setup({ projects: ['my-app'], ...opt });
    const r = await t.run({ DEPLOY: 'true', ANALYTICS: 'on', FUNCTIONS_DIR: t.fdir, ...env });
    assert.notEqual(r.code, 0, JSON.stringify(env));
    assert.match(r.err, re);
    assert.equal(t.wrangler(), '');
  }
});

test('统计关闭（默认）：不碰 D1，只发布静态产物', async () => {
  const t = setup({ projects: ['my-app'] });
  const r = await t.run({ DEPLOY: 'true', FUNCTIONS_DIR: t.fdir });
  assert.equal(r.code, 0, r.err);
  assert.ok(!state.calls.some((c) => c.includes('/d1/')));
  assert.equal(t.read('deployed.toml'), '');
});

test('保留期清理（d1-retention.sh，与发布解耦）：有库就删过期记录；无库跳过；查询失败只在统计从未开启时跳过', async () => {
  const id = '1111aaaa-bbbb-4ccc-8ddd-eeeeffff0002';
  const t = setup({ d1: { dbs: [{ name: 'my-app-analytics-x', uuid: '9999' }, { name: 'my-app-analytics', uuid: id }] } });
  const r = await t.run({ RETENTION_DAYS: '30' }, 'd1-retention.sh');
  assert.equal(r.code, 0, r.err);
  assert.equal(state.d1.queries.length, 1);
  assert.equal(state.d1.queries[0].db, id);
  assert.equal(state.d1.queries[0].sql, 'DELETE FROM events WHERE ts < ?1');
  assert.ok(Math.abs(state.d1.queries[0].params[0] - (Date.now() - 30 * 86400000)) < 120000);
  assert.ok(!state.calls.some((c) => c.includes('/pages/')), '清理不碰 Pages');

  const none = setup({ d1: { dbs: [{ name: 'my-app-analytics-x', uuid: '9999' }] } });
  assert.equal((await none.run({}, 'd1-retention.sh')).code, 0);
  assert.equal(state.d1.queries.length, 0);

  // ANALYTICS 从未设置：统计从未开启，不可能有数据，查询失败可跳过
  const noPerm = setup({ d1: { listFails: true } });
  assert.equal((await noPerm.run({}, 'd1-retention.sh')).code, 0);
  // 开着、或曾开启后关闭（off）：查询失败必须失败，不能显示成功
  for (const ANALYTICS of ['on', 'off']) {
    const t2 = setup({ d1: { listFails: true } });
    const r2 = await t2.run({ ANALYTICS }, 'd1-retention.sh');
    assert.notEqual(r2.code, 0, ANALYTICS);
    assert.match(r2.err, /D1 → Edit/);
  }
  // 关闭后查询成功、确认没有库：安全跳过
  const offNone = setup({ d1: { dbs: [] } });
  assert.equal((await offNone.run({ ANALYTICS: 'off' }, 'd1-retention.sh')).code, 0);

  const bad = setup({ d1: { dbs: [{ name: 'my-app-analytics', uuid: id }], queryFails: true } });
  assert.notEqual((await bad.run({}, 'd1-retention.sh')).code, 0);
  assert.notEqual((await bad.run({ RETENTION_DAYS: 'x' }, 'd1-retention.sh')).code, 0);
  // 保留期上限：超过隐私说明的 180 天不删也不放过
  const long = setup({ d1: { dbs: [{ name: 'my-app-analytics', uuid: id }] } });
  const r3 = await long.run({ RETENTION_DAYS: '365' }, 'd1-retention.sh');
  assert.notEqual(r3.code, 0);
  assert.match(r3.err, /180/);
  assert.equal(state.d1.queries.length, 0);
  assert.equal((await long.run({ RETENTION_DAYS: '180' }, 'd1-retention.sh')).code, 0);
});

// 隐私说明里的天数与脚本上限必须是同一个数。
// 模板里的“隐私说明”是 docs/ANALYTICS.md；项目把对用户展示的隐私文案放在别处时，把这里的路径改过去。
test('保留期上限与隐私说明一致', { skip: optionalMissing('docs/ANALYTICS.md') }, () => {
  const text = readFileSync(join(HERE, '../../docs/ANALYTICS.md'), 'utf8');
  const promised = /满 (\d+) 天自动删除/.exec(text)?.[1];
  assert.equal(promised, '180');
  for (const f of ['pages.sh', 'd1-retention.sh']) {
    assert.match(readFileSync(join(HERE, f), 'utf8'), new RegExp(`\\[ "\\$RETENTION_DAYS" -le ${promised} \\]`), f);
  }
});

test('analytics-retention.yml：每天定时、只在 main 上运行、只读权限，调用 d1-retention.sh 且不依赖 ANALYTICS 开关', { skip: optionalMissing('.github/workflows/analytics-retention.yml') }, () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/analytics-retention.yml'), 'utf8');
  assert.match(yml, /schedule:\n\s+- cron: '17 19 \* \* \*'/);
  assert.match(yml, /if: github\.ref == 'refs\/heads\/main' && vars\.PAGES_PROJECT != ''$/m);
  assert.match(yml, /^permissions:\n {2}contents: read$/m);
  assert.match(yml, /run: bash scripts\/devloop\/d1-retention\.sh/);
  assert.ok(!/if: .*ANALYTICS/.test(yml), '统计关闭后也要继续清理');
});

// 发布时 pages.sh 也会清理一次，必须与每日清理用同一个保留期，否则 RETENTION_DAYS 调大时会多删
test('ci.yml 与 analytics-retention.yml 传同一个 RETENTION_DAYS 给清理脚本', { skip: optionalMissing('.github/workflows/analytics-retention.yml') }, () => {
  const expr = "RETENTION_DAYS: ${{ vars.RETENTION_DAYS || '180' }}";
  const ci = readFileSync(join(HERE, '../../.github/workflows/ci.yml'), 'utf8');
  const step = ci.slice(ci.indexOf('- name: 发布到 Cloudflare Pages'));
  assert.ok(step.slice(0, step.indexOf('run: bash _devloop/scripts/devloop/pages.sh')).includes(expr), 'ci.yml 发布步骤没传 RETENTION_DAYS');
  assert.ok(readFileSync(join(HERE, '../../.github/workflows/analytics-retention.yml'), 'utf8').includes(expr));
});
