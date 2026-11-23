import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIX_NOTE, endpoint, makeTools, runAgent, safePath, withDiff } from './gpt-agent.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'agent-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'src/a.js'), 'export const a = 1;\n// TODO 车灯\n');
  writeFileSync(join(root, '.github/workflows/ci.yml'), 'on: push');
  writeFileSync(join(root, '.git/config'), '[core]');
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'secret'), 'x');
  symlinkSync(outside, join(root, 'escape'));
  return root;
}

test('safePath：越界、.git、workflows、node_modules、指向仓库外的符号链接都拒绝；写入不能经符号链接', () => {
  const root = repo();
  assert.equal(safePath(root, 'src/a.js').rel, 'src/a.js');
  for (const p of ['../x', '/etc/passwd', '.git/config', '.github/workflows/ci.yml', 'node_modules/x', 'src/../../x', 'escape/secret', '']) assert.throws(() => safePath(root, p), p);
  assert.throws(() => safePath(root, '.', { forWrite: true }));
  assert.equal(safePath(root, 'src/new/b.js', { forWrite: true }).rel, 'src/new/b.js');
});

test('safePath / 工具：仓库内指向禁区的符号链接（含链接链）不能绕过 DENY', () => {
  const root = repo();
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules/pkg/i.js'), 'NM');
  symlinkSync(join(root, '.git'), join(root, 'g'));
  symlinkSync('g', join(root, 'g2'));
  symlinkSync(join(root, '.github/workflows'), join(root, 'wf'));
  symlinkSync(join(root, 'node_modules'), join(root, 'nm'));
  symlinkSync(join(root, '.git/config'), join(root, 'src/cfg'));
  for (const p of ['g', 'g/config', 'g2/config', 'wf/ci.yml', 'nm/pkg/i.js', 'src/cfg']) assert.throws(() => safePath(root, p), /不允许访问/, p);
  const { tools } = makeTools(root, 'read');
  assert.throws(() => tools.read_file.run({ path: 'g2/config' }));
  assert.throws(() => tools.list_dir.run({ path: 'wf' }));
  assert.throws(() => tools.search.run({ pattern: 'core', path: 'g' }));
  assert.equal(tools.search.run({ pattern: 'core|on: push|NM' }), '（无匹配）');
  assert.doesNotMatch(tools.list_dir.run({ path: '.' }), /node_modules/);
  // 指向仓库根目录与 .github 父目录的链接：搜索与列目录都不能借道进入禁区
  symlinkSync(root, join(root, 'self'));
  symlinkSync(join(root, '.github'), join(root, 'gh'));
  assert.equal(tools.search.run({ pattern: 'core|on: push|NM', path: 'self' }), '（无匹配）');
  assert.equal(tools.search.run({ pattern: 'on: push', path: 'gh' }), '（无匹配）');
  assert.match(tools.search.run({ pattern: '车灯', path: 'self' }), /^src\/a\.js:2:/);
  assert.doesNotMatch(tools.list_dir.run({ path: 'self' }), /\.git\/|node_modules/);
  assert.doesNotMatch(tools.list_dir.run({ path: 'gh' }), /workflows/);
  for (const p of ['self/.git/config', 'gh/workflows/ci.yml', 'self/node_modules/pkg/i.js']) assert.throws(() => tools.read_file.run({ path: p }), p);
});

test('工具：read 模式没有写工具；search 跳过禁区；write_file / delete_file 记录改动', () => {
  const root = repo();
  assert.deepEqual(Object.keys(makeTools(root, 'read').tools).sort(), ['list_dir', 'read_file', 'search']);
  const { tools, changed } = makeTools(root, 'write');
  assert.match(tools.search.run({ pattern: '车灯' }), /^src\/a\.js:2:/);
  assert.equal(tools.search.run({ pattern: 'on: push' }), '（无匹配）', '不搜 workflows');
  assert.doesNotMatch(tools.list_dir.run({ path: '.' }), /\.git\//);
  tools.write_file.run({ path: 'src/b.js', content: 'b' });
  tools.delete_file.run({ path: 'src/a.js' });
  assert.equal(readFileSync(join(root, 'src/b.js'), 'utf8'), 'b');
  assert.ok(!existsSync(join(root, 'src/a.js')));
  assert.deepEqual([...changed].sort(), ['src/a.js', 'src/b.js']);
  assert.throws(() => tools.write_file.run({ path: '.github/workflows/x.yml', content: 'x' }));
});

test('runAgent：函数调用循环，工具错误回给模型而不中断，finish 的参数就是结果；接续用 previous_response_id', async () => {
  const root = repo();
  const bodies = [];
  const replies = [
    { id: 'r1', output: [{ type: 'reasoning' }, { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"src/a.js"}' }, { type: 'function_call', call_id: 'c2', name: 'read_file', arguments: '{"path":"../x"}' }] },
    { id: 'r2', output: [{ type: 'function_call', call_id: 'c3', name: 'write_file', arguments: '{"path":"src/a.js","content":"export const a = 2;\\n"}' }] },
    { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: '好了' }] }] },
    { id: 'r4', output: [{ type: 'function_call', call_id: 'c4', name: 'finish', arguments: '{"outcome":"pr","title":"t","body":"b"}' }], usage: { total_tokens: 9 } },
  ];
  const fetchImpl = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return { ok: true, status: 200, text: async () => JSON.stringify(replies[bodies.length - 1]) };
  };
  const schema = { type: 'object', properties: { outcome: { type: 'string' } } };
  const r = await runAgent({ mode: 'write', root, prompt: 'P', schema, env: { OPENAI_API_KEY: 'k', MODEL: 'gpt-x' }, fetchImpl });
  assert.deepEqual(r.result, { outcome: 'pr', title: 't', body: 'b' });
  assert.deepEqual(r.changed, ['src/a.js']);
  assert.equal(readFileSync(join(root, 'src/a.js'), 'utf8'), 'export const a = 2;\n');
  assert.equal(bodies[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(bodies[0].auth, 'Bearer k');
  assert.equal(bodies[0].body.model, 'gpt-x');
  assert.equal(bodies[0].body.reasoning.effort, 'high');
  assert.deepEqual(bodies[0].body.tools.find((t) => t.name === 'finish').parameters, schema);
  assert.ok(!bodies[0].body.tools.some((t) => /exec|shell|run/.test(t.name)), '没有执行命令的工具');
  assert.equal(bodies[1].body.previous_response_id, 'r1');
  const outs = bodies[1].body.input;
  assert.match(outs.find((o) => o.call_id === 'c1').output, /export const a = 1/);
  assert.match(outs.find((o) => o.call_id === 'c2').output, /^错误：路径越界/);
  assert.match(bodies[3].body.input[0].content, /finish/, '没有调用工具时提醒用 finish 收尾');
});

test('runAgent：轮次用完没有 finish → 报错；4xx 不重试直接报错', async () => {
  const root = repo();
  const loop = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'x', output: [{ type: 'function_call', call_id: 'c', name: 'list_dir', arguments: '{"path":"."}' }] }) });
  await assert.rejects(runAgent({ mode: 'read', root, prompt: 'P', schema: {}, env: { MODEL: 'm' }, fetchImpl: loop, maxTurns: 3 }), /3 轮内没有调用 finish/);
  let n = 0;
  const bad = async () => { n++; return { ok: false, status: 401, text: async () => '{"error":{"code":"invalid_api_key"}}' }; };
  await assert.rejects(runAgent({ mode: 'read', root, prompt: 'P', schema: {}, env: { MODEL: 'm' }, fetchImpl: bad }), /HTTP 401.*invalid_api_key/);
  assert.equal(n, 1);
  assert.equal(endpoint({ GPT_RESPONSES_ENDPOINT: 'https://gw/v1/responses' }), 'https://gw/v1/responses');
});

test('withDiff：把 git diff 那行换成预生成的改动附在末尾，过长截断', () => {
  const p = '你是审核方 GPT\n用 `git diff a...HEAD` 查看完整改动。\n结尾';
  const out = withDiff(p, { stat: 'S', diff: 'D', log: 'L' });
  assert.doesNotMatch(out, /用 `git diff/);
  assert.match(out, /附在本提示词末尾[\s\S]*## 完整 diff\n\n```diff\nD\n```$/);
  assert.match(withDiff(p, { diff: 'x'.repeat(200_001) }), /过长[\s\S]*read_diff 从 offset=200000/);
  assert.throws(() => withDiff('没有那一行', {}), /找不到/);
  // 修复模式换成修复用的说明（告诉模型怎样按 diff 撤回改动）
  const fix = withDiff('你是主设 GPT\n用 `git diff origin/main...HEAD` 查看本 PR 相对 main 的已有改动。\n结尾', { diff: 'D' }, FIX_NOTE);
  assert.match(fix, /相对 main 的已有改动[\s\S]*delete_file 删除[\s\S]*```diff\nD\n```$/);
  assert.doesNotMatch(fix, /你只需审代码/);
});

test('runAgent：给了 diffText 就多一个只读、可分页的 read_diff 工具，能读到截断之后的部分', async () => {
  const root = repo();
  const diff = 'a'.repeat(130_000) + 'TAIL';
  const bodies = [];
  const replies = [
    { id: 'r1', output: [{ type: 'function_call', call_id: 'c1', name: 'read_diff', arguments: '{"offset":120000}' }] },
    { id: 'r2', output: [{ type: 'function_call', call_id: 'c2', name: 'finish', arguments: '{"verdict":"approve"}' }] },
  ];
  const fetchImpl = async (u, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify(replies[bodies.length - 1]) }; };
  await runAgent({ mode: 'read', root, prompt: 'P', schema: {}, env: { MODEL: 'm' }, diffText: diff, fetchImpl });
  assert.ok(bodies[0].tools.some((t) => t.name === 'read_diff'));
  assert.ok(!bodies[0].tools.some((t) => t.name === 'write_file'));
  assert.match(bodies[1].input[0].output, /TAIL$/);
});

test('runAgent：429 / 5xx / 网络错误重试后成功；重试用尽报错；重试与退避都不越过总时限', async () => {
  const root = repo();
  const fin = { ok: true, status: 200, text: async () => JSON.stringify({ id: 'r', output: [{ type: 'function_call', call_id: 'c', name: 'finish', arguments: '{"ok":true}' }] }) };
  const err = (status) => ({ ok: false, status, text: async () => '{"error":"x"}' });
  const base = { mode: 'read', root, prompt: 'P', schema: {}, env: { MODEL: 'm' } };
  // 重试后成功：一次 429、一次网络错误，第三次成功；退避时长按 15s / 20s 走假时钟
  let t = 0;
  const waits = [];
  const seq1 = [() => err(429), () => { throw new TypeError('fetch failed'); }, () => fin];
  let n = 0;
  const r = await runAgent({ ...base, fetchImpl: async () => seq1[n++](), now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  assert.deepEqual(r.result, { ok: true });
  assert.deepEqual(waits, [15_000, 20_000]);
  // 重试用尽：三次 503
  n = 0;
  await assert.rejects(runAgent({ ...base, fetchImpl: async () => { n++; return err(503); }, now: () => 0, sleep: async () => {} }), /HTTP 503/);
  assert.equal(n, 3);
  // 请求期间时钟越过总时限：即便返回成功也不接受，也不再发第二次
  t = 0;
  n = 0;
  await assert.rejects(runAgent({ ...base, deadlineMs: 1000, fetchImpl: async () => { n++; t = 1001; return err(500); }, now: () => t, sleep: async () => {} }), /超出总时限/);
  assert.equal(n, 1);
  t = 0;
  await assert.rejects(runAgent({ ...base, deadlineMs: 1000, fetchImpl: async () => { t = 1001; return fin; }, now: () => t, sleep: async () => {} }), /超出总时限/);
  // 剩余时间不够退避：直接报超时，不睡、不重试
  t = 0;
  n = 0;
  const slept = [];
  await assert.rejects(runAgent({ ...base, deadlineMs: 10_000, fetchImpl: async () => { n++; return err(502); }, now: () => t, sleep: async (ms) => slept.push(ms) }), /超出总时限/);
  assert.equal(n, 1);
  assert.deepEqual(slept, []);
});
