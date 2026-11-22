import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endpoint, makeTools, runAgent, safePath, withDiff } from './gpt-agent.mjs';

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
  assert.match(withDiff(p, { diff: 'x'.repeat(200_001) }), /过长/);
  assert.throws(() => withDiff('没有那一行', {}), /找不到/);
});
