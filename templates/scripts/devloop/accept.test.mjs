// 验收与发布角色：合并排期、用户确认、视觉评分结论、预览发布与回滚的工作流约束
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acceptanceGate, acceptanceState, followUpsAccept, isAwaiting, isInFlight, isVisual, loadGates, queueBlocker, reportPlan, visualRounds, VISUAL_PREFIX } from './accept.mjs';
import { buildParts, canaryOk, canaryPng, judge, loadShots, outputText, parseVerdict, run, toRequest } from './visual-judge.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// 只装了云端审核、没装验收模块（没有 gates.json）时整组跳过
const installed = loadGates();
const skip = !installed && '未安装验收与发布角色（scripts/devloop/gates.json）';
// 测试用固定的路径规则，不依赖项目自己的 gates.json 配置
const gates = { visual: { paths: [] }, judge: {}, ...installed, visual: { ...(installed?.visual ?? { waitLabel: 'awaiting-acceptance', acceptLabel: 'accepted' }), paths: ['src/geometry/', 'src/client/scene.ts'] } };
const V = gates.visual;
const open = (n, files, labels = []) => ({ number: n, files, labels, state: 'OPEN', isDraft: false, baseRefName: 'main' });

test('isVisual：目录前缀与精确文件', { skip }, () => {
  assert.ok(isVisual(['src/geometry/placeholder.ts'], V));
  assert.ok(isVisual(['README.md', 'src/client/scene.ts'], V));
  assert.ok(Array.isArray(loadGates().visual.paths) && loadGates().visual.paths.length, 'gates.json 配了画面路径');
  assert.equal(loadGates(undefined, () => false), null, '没有 gates.json = 不启用');
  assert.ok(!isVisual(['src/shared/economy.ts', 'src/client/scene.ts.bak'], V));
});

test('合并排期：只被更早、在途、改同一文件的 PR 挡住；等人的 PR 不挡', { skip }, () => {
  const m = open(9, ['src/a.ts', 'src/b.ts']);
  assert.equal(queueBlocker(m, [open(5, ['src/b.ts']), open(7, ['src/a.ts']), m], V), 5);
  assert.equal(queueBlocker(m, [open(12, ['src/a.ts']), m], V), null, '更晚的不挡');
  assert.equal(queueBlocker(m, [open(5, ['src/c.ts']), m], V), null, '不同文件不挡');
  for (const labels of [['needs-user'], ['hold']]) assert.equal(queueBlocker(m, [open(5, ['src/a.ts'], labels), m], V), null, labels.join());
  const H = 'a'.repeat(40);
  const awaiting = { ...open(5, ['src/a.ts'], [V.waitLabel]), headRefOid: H, markers: [{ state: 'retry', reason: 'accept', head: H }] };
  assert.equal(queueBlocker(m, [awaiting, m], V), null, '等用户验收的不挡');
  assert.equal(queueBlocker(m, [open(5, ['src/a.ts'], [V.waitLabel, V.acceptLabel]), m], V), 5, '用户已确认、马上要合的仍在途');
  assert.equal(queueBlocker(m, [{ ...open(5, ['src/a.ts']), isDraft: true }, m], V), null, '草稿不挡');
  assert.ok(isInFlight(open(5, [], [V.waitLabel]), V), '只有标签、没有当前 head 的等待标记：照常处理');
});

test('用户确认：绑定在最后一次“等待验收”的 head 上，所有者在它之后打 accepted 才算；换 head（含推更早的提交）、之后摘掉、别人打都不算', { skip }, () => {
  const H1 = 'a'.repeat(40);
  const H2 = 'b'.repeat(40);
  const ev = (event, login, at, name = V.acceptLabel) => ({ event, label: { name }, actor: { login }, created_at: at });
  const wait = (head, at) => ({ state: 'retry', reason: 'accept', head, base: 'c'.repeat(40), at });
  const st = (events, markers, head = H1) => acceptanceState({ events, owner: 'owner', label: V.acceptLabel, markers, head });
  const w1 = [wait(H1, '2026-11-21T10:00:00Z')];
  assert.equal(st([ev('labeled', 'owner', '2026-11-21T11:00:00Z')], w1), 'accepted');
  assert.equal(st([ev('labeled', 'owner', '2026-11-21T09:00:00Z')], w1), 'stale', '早于等待验收');
  assert.equal(st([ev('labeled', 'owner', '2026-11-21T11:00:00Z')], w1, H2), 'stale', 'head 换了');
  assert.equal(st([ev('labeled', 'owner', '2026-11-21T11:00:00Z')], [wait(H2, '2026-11-21T08:00:00Z'), ...w1], H2), 'stale', '换回更早评过的提交：最后一次等待验收不是它');
  assert.equal(st([ev('labeled', 'owner', '2026-11-21T11:00:00Z')], []), 'stale', '从没等待验收过');
  assert.equal(st([ev('labeled', 'github-actions[bot]', '2026-11-21T11:00:00Z')], w1), 'none');
  assert.equal(st([ev('labeled', 'owner', '2026-11-21T11:00:00Z'), ev('unlabeled', 'owner', '2026-11-21T11:05:00Z')], w1), 'none');
  assert.equal(st([ev('labeled', 'owner', '2026-11-21T11:00:00Z'), ev('labeled', 'owner', '2026-11-21T11:01:00Z', 'bug')], w1), 'accepted');
  assert.equal(st([], w1), 'none');
});

test('等待验收只针对被评过的 head：推了新提交就重新处理', { skip }, () => {
  const H1 = 'a'.repeat(40);
  const m = (head) => ({ ...open(5, ['src/a.ts'], [V.waitLabel]), headRefOid: head, markers: [{ state: 'retry', reason: 'accept', head: H1 }] });
  assert.ok(isAwaiting(m(H1), V));
  assert.ok(!isAwaiting(m('b'.repeat(40)), V));
  assert.ok(isInFlight(m('b'.repeat(40)), V));
  assert.ok(!isAwaiting({ ...m(H1), labels: [V.waitLabel, V.acceptLabel] }, V));
});

test('视觉评分结论：通过 → 等用户；未达标 → 交 Claude 修，到上限停下；评分没完成 → 交人工，不自动通过', { skip }, () => {
  const base = { pr: 69, head: 'a'.repeat(40), preview: 'https://pr-69.x.pages.dev', runUrl: 'https://github.com/o/r/actions/runs/1', maxRounds: 3, visual: V };
  const scores = { palette: 7, shape: 7, lighting: 6, readability: 8, regression: 9 };
  const pass = reportPlan({ ...base, rounds: 0, judge: { verdict: 'pass', scores, overall: 7.4, notes: [], model: 'gpt' } });
  assert.equal(pass.action, 'await');
  assert.deepEqual(pass.labelsAdd, [V.waitLabel]);
  assert.ok(pass.body.startsWith(VISUAL_PREFIX));
  assert.match(pass.body, /pr-69\.x\.pages\.dev/);
  assert.match(pass.body, new RegExp(`\`${V.acceptLabel}\``));
  const fail = { verdict: 'fail', scores, overall: 5, notes: ['车身太灰'], reason: '平均 5 < 6', model: 'gpt' };
  const fix = reportPlan({ ...base, rounds: 0, judge: fail });
  assert.equal(fix.action, 'fix');
  assert.deepEqual(fix.labelsRemove, [V.waitLabel]);
  assert.match(fix.body, /结论：未达标/);
  assert.equal(reportPlan({ ...base, rounds: 2, judge: fail }).action, 'stop');
  const err = reportPlan({ ...base, rounds: 0, judge: { verdict: 'error', reason: '多模态自检失败' } });
  assert.equal(err.action, 'await');
  assert.match(err.body, /没有完成（多模态自检失败）/);
  const bot = 'github-actions[bot]';
  assert.equal(visualRounds([{ author: bot, body: fix.body }, { author: bot, body: pass.body }, { author: bot, body: '执行者：GPT\n结论：未达标' }]), 1);
  assert.equal(visualRounds([{ author: 'someone', body: fix.body }, { author: '', body: fix.body }]), 0, '别人仿写的验收报告不计轮次');
});

test('评分解析与门槛', { skip }, () => {
  const ok = parseVerdict('说明\n{"scores":{"palette":6,"shape":7,"lighting":6,"readability":6,"regression":8},"notes":["a"]}');
  assert.equal(judge(ok, { minEach: 4, minOverall: 6 }).verdict, 'pass');
  assert.equal(judge({ ...ok, scores: { ...ok.scores, lighting: 3 } }, { minEach: 4, minOverall: 6 }).verdict, 'fail');
  assert.equal(judge({ ...ok, scores: { ...ok.scores, regression: 5 } }, { minEach: 4, minOverall: 6 }).verdict, 'fail');
  assert.throws(() => parseVerdict('{"scores":{"palette":11}}'));
  assert.throws(() => parseVerdict('没有 JSON'));
});

test('截图读取：只认白名单内的 PNG，大小受限', { skip }, () => {
  const files = { '/d/shot-home.png': canaryPng(), '/d/shot-interact.png': Buffer.from('<svg>'), '/d/vehicle-side.png': Buffer.alloc(10_000_000) };
  const fs = { existsSync: (f) => f === '/d' || f in files, statSync: (f) => ({ size: files[f].length }), readFileSync: (f) => files[f] };
  assert.deepEqual(loadShots('/d', ['shot-home.png', 'shot-interact.png', 'vehicle-side.png', '../x.png'], 3_000_000, fs).map((s) => s.name), ['shot-home.png']);
});

test('评分：默认 GPT（Responses API），可配置为 Claude；先过多模态自检，答错 / 调用失败 / 没配模型都是 error（不自动通过）', { skip }, async () => {
  const fs = { existsSync: (f) => ['/d', '/d/shot-home.png', '/ref.png'].includes(f), statSync: () => ({ size: 100 }), readFileSync: (f) => (f === '/style' ? '风格' : canaryPng()) };
  const cfg = { ...gates.judge, shots: ['shot-home.png'] };
  const env = { OPENAI_API_KEY: 'k', GPT_RESPONSES_ENDPOINT: 'https://gw/v1/responses', VISUAL_MODEL: 'gpt-x', ANTHROPIC_API_KEY: 'ak', ANTHROPIC_BASE_URL: 'https://gw2/' };
  const SCORE = '{"scores":{"palette":7,"shape":7,"lighting":7,"readability":7,"regression":9},"notes":[]}';
  const CANARY = '{"tl":"red","tr":"green","bl":"blue","br":"yellow"}';
  const rig = (provider, answers) => {
    const calls = [];
    const reply = (text) => ({ ok: true, status: 200, json: async () => (provider === 'openai' ? { output: [{ content: [{ type: 'output_text', text }] }] } : { content: [{ type: 'text', text }] }) });
    const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return reply(answers[calls.length - 1]); };
    return { calls, fetchImpl };
  };
  const g = rig('openai', [CANARY, SCORE]);
  const r = await run({ shotsDir: '/d', baselineDir: '/none', referencePath: '/ref.png', stylePath: '/style', title: 't', env, cfg, fetchImpl: g.fetchImpl, fs });
  assert.equal(r.verdict, 'pass', JSON.stringify(r));
  assert.equal(r.provider, 'openai');
  assert.equal(r.reference, true);
  assert.ok(g.calls.every((c) => c.url === 'https://gw/v1/responses' && c.headers.authorization === 'Bearer k' && c.body.model === 'gpt-x'));
  assert.ok(!JSON.stringify(g.calls).includes('"ak"'), '不把 Claude 的 key 发给 GPT 网关');
  assert.equal(JSON.stringify(g.calls[1].body).match(/input_image/g).length, 2, '参考图 + 1 张截图');
  const c = rig('anthropic', [CANARY, SCORE]);
  const rc = await run({ provider: 'anthropic', model: 'claude-opus-5-5', shotsDir: '/d', stylePath: '/style', env, cfg, fetchImpl: c.fetchImpl, fs });
  assert.equal(rc.verdict, 'pass', JSON.stringify(rc));
  assert.ok(c.calls.every((x) => x.url === 'https://gw2/v1/messages' && x.headers['x-api-key'] === 'ak' && x.body.model === 'claude-opus-5-5'));
  const blind = rig('openai', ['{"tl":"red","tr":"red","bl":"red","br":"red"}', SCORE]);
  const rb = await run({ shotsDir: '/d', stylePath: '/style', env, cfg, fs, fetchImpl: blind.fetchImpl });
  assert.equal(rb.verdict, 'error');
  assert.match(rb.reason, /多模态自检失败/);
  assert.equal(blind.calls.length, 1, '自检失败就不再评分');
  const down = await run({ shotsDir: '/d', stylePath: '/style', env, cfg, fs, fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ error: 'bad gateway' }) }) });
  assert.equal(down.verdict, 'error');
  const nomodel = await run({ shotsDir: '/d', stylePath: '/style', env: { OPENAI_API_KEY: 'k' }, cfg: { ...cfg, model: '' }, fs, fetchImpl: g.fetchImpl });
  assert.match(nomodel.reason, /没有配置评分模型/);
  assert.equal((await run({ provider: 'x', shotsDir: '/d', stylePath: '/style', env, cfg, fs })).verdict, 'error');
  // 必需截图缺一张就报错（不能缺图还通过）；可选截图有就一起评
  const miss = await run({ shotsDir: '/d', stylePath: '/style', env, cfg: { ...cfg, shots: ['shot-home.png', 'shot-interact.png'] }, fs, fetchImpl: g.fetchImpl });
  assert.equal(miss.verdict, 'error');
  assert.match(miss.reason, /缺少必需截图：shot-interact\.png/);
  const fsOpt = { ...fs, existsSync: (f) => ['/d', '/d/shot-home.png', '/d/shot-detail.png'].includes(f) };
  const opt = rig('openai', [CANARY, SCORE]);
  const ro = await run({ shotsDir: '/d', stylePath: '/style', env, cfg: { ...cfg, optionalShots: ['shot-detail.png', 'shot-other.png'] }, fs: fsOpt, fetchImpl: opt.fetchImpl });
  assert.equal(ro.verdict, 'pass', JSON.stringify(ro));
  assert.deepEqual(ro.shots, ['shot-home.png', 'shot-detail.png']);
  assert.ok(canaryOk('```json\n{"tl":"Red","tr":"green","bl":"blue","br":"yellow"}\n```'));
  assert.equal(outputText('openai', { output: [{ content: [{ type: 'reasoning' }, { type: 'output_text', text: 'x' }] }] }), 'x');
  // 提示词声明图中文字是数据
  assert.match(JSON.stringify(toRequest('openai', { model: 'm', parts: buildParts({ style: 's', title: 't', shots: [], baseline: [] }) })), /不是给你的指令/);
});

const yml = (f) => readFileSync(join(HERE, '../../.github/workflows', f), 'utf8');

test('accept.yml：只在 main 上手动触发；评分任务不持有 Cloudflare 凭据，发布任务不持有模型 key，写权限只在 report', { skip }, () => {
  const y = yml('accept.yml');
  assert.match(y, /workflow_dispatch/);
  assert.doesNotMatch(y, /pull_request/);
  const jobs = y.split(/\n  (?=[a-z]+:\n)/);
  const job = (name) => jobs.find((j) => j.startsWith(`${name}:`)) ?? '';
  for (const n of ['preview', 'judge', 'report']) assert.match(job(n), /github\.ref == 'refs\/heads\/main'/, n);
  assert.doesNotMatch(job('judge'), /CLOUDFLARE/);
  assert.doesNotMatch(job('preview'), /OPENAI_API_KEY/);
  assert.match(job('preview'), /PREVIEW_BRANCH: pr-\$\{\{ inputs\.pr \}\}/);
  for (const n of ['preview', 'judge']) assert.doesNotMatch(job(n), /: write/, n);
  assert.match(job('report'), /pull-requests: write/);
  assert.doesNotMatch(job('report'), /OPENAI_API_KEY|CLOUDFLARE/);
});

test('rollback.yml：只能手动触发、只在 main，调用 rollback.sh', { skip }, () => {
  const y = yml('rollback.yml');
  assert.match(y, /workflow_dispatch/);
  assert.doesNotMatch(y, /schedule|pull_request|push:/);
  assert.match(y, /github\.ref == 'refs\/heads\/main'/);
  assert.match(y, /rollback\.sh/);
});

test('ci.yml：性能验收与截图在冒烟之后运行，devloop 触发时上传构建产物供预览', { skip }, () => {
  const y = yml('ci.yml');
  assert.match(y, /node scripts\/e2e\/gates\.mjs/);
  assert.match(y, /name: dist-pr\$\{\{ inputs\.pr \}\}-\$\{\{ inputs\.head \}\}/);
});

test('合并前把关 acceptanceGate：只拦“要合并、改画面、当前 head 没确认”的 PR；先建标签再等用户', () => {
  const g = { visual: { paths: ['src/client/'], waitLabel: 'awaiting-acceptance', acceptLabel: 'accepted' } };
  const merge = { state: 'merged', merge: true, text: 'ok' };
  const calls = [];
  const ghR = (a) => calls.push(a.join(' '));
  const base = { pr: 7, head: 'h1', markers: [], gates: g, ghR, runUrl: 'https://github.com/o/r/actions/runs/123' };
  // 不改画面 / 没装模块 / 本来就不合并：原样放行
  assert.equal(acceptanceGate({ ...base, d: merge, files: ['README.md'], acceptance: () => 'none' }).d, merge);
  assert.equal(acceptanceGate({ ...base, d: merge, files: ['src/client/a.ts'], gates: null, acceptance: () => 'none' }).d, merge);
  const changes = { state: 'changes', merge: false };
  assert.equal(acceptanceGate({ ...base, d: changes, files: ['src/client/a.ts'], acceptance: () => 'none' }).d, changes);
  // 已确认当前 head：放行合并
  assert.equal(acceptanceGate({ ...base, d: merge, files: ['src/client/a.ts'], acceptance: () => 'accepted' }).d, merge);
  // 没确认：不合并，先建两个标签，再等用户，触发 accept.yml
  const r = acceptanceGate({ ...base, d: merge, files: ['src/client/a.ts'], acceptance: () => 'none' });
  assert.deepEqual([r.d.state, r.d.reason, r.d.merge, r.d.addLabel], ['retry', 'accept', false, 'awaiting-acceptance']);
  assert.deepEqual(r.accept, { head: 'h1', run: '123' });
  assert.ok(calls[0].startsWith('label create awaiting-acceptance') && calls[1].startsWith('label create accepted'));
  assert.deepEqual(followUpsAccept(7, r.accept), [['workflow', 'run', 'accept.yml', '--ref', 'main', '-f', 'pr=7', '-f', 'head=h1', '-f', 'run=123']]);
  // 确认已失效：摘掉旧 accepted；拿不到运行号就不触发，并在评论里说明
  calls.length = 0;
  const s = acceptanceGate({ ...base, d: merge, files: ['src/client/a.ts'], runUrl: null, acceptance: () => 'stale' });
  assert.ok(calls.includes('pr edit 7 --remove-label accepted'));
  assert.equal(s.accept, null);
  assert.match(s.d.text, /已失效/);
  assert.match(s.d.text, /拿不到 CI 运行号/);
});

test('本机与云端两个合并入口都走 acceptanceGate（本机兜底改工作流的 PR、云端审核关闭时也绕不过验收）', () => {
  for (const f of ['devloop.mjs', 'cloud.mjs']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    const gate = src.indexOf('acceptanceGate({');
    const mergeAt = src.indexOf('if (d.merge) {');
    assert.ok(gate > 0 && mergeAt > gate, `${f}：合并前先过 acceptanceGate`);
  }
});
