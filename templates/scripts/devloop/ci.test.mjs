import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCi } from './ci.mjs';

const pr = 6;
const head = 'h';
const base = 'b';

function fakeIo(over = {}) {
  let t = 0;
  let nonce = null;
  return {
    dispatch: async (inputs) => {
      nonce = inputs.nonce;
    },
    listDispatchRuns: async () => [{ displayTitle: `devloop ${nonce} PR#6`, status: 'completed', conclusion: 'success', url: 'u' }],
    listPrRuns: async () => [],
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    ...over,
  };
}

const run = (io) => runCi({ pr, head, base, io, timeoutMs: 60_000, pollMs: 15_000 });

test('正常：success → ok；failure / timed_out → failed；cancelled → error', async () => {
  assert.equal((await run(fakeIo())).status, 'ok');
  for (const [c, want] of [['failure', 'failed'], ['timed_out', 'failed'], ['cancelled', 'error']]) {
    const io = fakeIo();
    let nonce;
    io.dispatch = async (i) => {
      nonce = i.nonce;
    };
    io.listDispatchRuns = async () => [{ displayTitle: `devloop ${nonce}`, status: 'completed', conclusion: c, url: 'u' }];
    assert.equal((await run(io)).status, want);
  }
});

test('查询一直抛异常：不向外抛，超时后返回 error', async () => {
  const r = await run(fakeIo({ listDispatchRuns: async () => { throw new Error('gh: network down'); } }));
  assert.equal(r.status, 'error');
  assert.match(r.note, /超时/);
});

test('查询偶发失败后恢复：继续轮询并拿到结果', async () => {
  let n = 0;
  const io = fakeIo();
  let nonce;
  io.dispatch = async (i) => {
    nonce = i.nonce;
  };
  io.listDispatchRuns = async () => {
    if (n++ < 2) throw new Error('flaky');
    return [{ displayTitle: `devloop ${nonce}`, status: 'completed', conclusion: 'success', url: 'u' }];
  };
  assert.equal((await run(io)).status, 'ok');
});

test('触发失败（非 workflow_dispatch 原因）→ error；回退查询抛异常 → error', async () => {
  assert.equal((await run(fakeIo({ dispatch: async () => { throw new Error('HTTP 500'); } }))).status, 'error');
  const r = await run(
    fakeIo({
      dispatch: async () => { throw new Error("Workflow does not have 'workflow_dispatch' trigger"); },
      listPrRuns: async () => { throw new Error('JSON parse error'); },
    }),
  );
  assert.equal(r.status, 'error');
  assert.match(r.note, /查询出错/);
});

test('回退：只接受 head 与 base 都吻合的 pull_request 运行', async () => {
  const prRun = (b) => ({ path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'x', pull_requests: [{ number: 6, head: { sha: head }, base: { sha: b } }] });
  const io = (runs) => fakeIo({ dispatch: async () => { throw new Error('workflow_dispatch'); }, listPrRuns: async () => runs });
  assert.equal((await run(io([prRun(base)]))).status, 'ok');
  assert.equal((await run(io([prRun('other')]))).status, 'error');
});

test('io 本身意外抛出（例如 now 出错）：仍返回 error 而不是抛出', async () => {
  const r = await run(fakeIo({ now: () => { throw new Error('boom'); } }));
  assert.equal(r.status, 'error');
});

test('回退判断看完整错误信息：原因在 stderr 或第二行时也能识别', async () => {
  const prRun = { path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', html_url: 'x', pull_requests: [{ number: 6, head: { sha: head }, base: { sha: base } }] };
  const multiLine = new Error("Command failed: gh workflow run ci.yml\ncould not create workflow dispatch event: HTTP 422: Workflow does not have 'workflow_dispatch' trigger");
  const viaStderr = Object.assign(new Error('Command failed: gh workflow run ci.yml'), { stderr: "HTTP 422: Workflow does not have 'workflow_dispatch' trigger" });
  for (const err of [multiLine, viaStderr]) {
    const r = await run(fakeIo({ dispatch: async () => { throw err; }, listPrRuns: async () => [prRun] }));
    assert.equal(r.status, 'ok');
  }
});
