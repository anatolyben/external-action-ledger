import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createActionLedger, createMemoryStore } from '../src/index.js';

test('real HTTP socket loss after an external effect does not cause duplicate dispatch', async () => {
  let providerCalls = 0;
  const effects = [];
  const server = http.createServer(async (request, response) => {
    providerCalls++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    effects.push(JSON.parse(Buffer.concat(chunks).toString()));
    // Persist the simulated effect, then lose the response at the socket layer.
    response.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const actions = createActionLedger({ store: createMemoryStore() });
  const ref = { namespace: 'http-test', key: 'post-once' };
  const adapter = context => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/publish', headers: { 'content-type': 'application/json' } }, response => {
      response.resume();
      response.once('end', () => resolve({ outcome: 'applied', receipt: { status: response.statusCode } }));
    });
    request.once('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('deadline')));
    request.end(JSON.stringify({ effectKey: context.effectKey, payload: context.payload }));
  });
  try {
    await actions.enqueue({ ...ref, kind: 'publish', payload: { text: 'one post' } });
    const claim = await actions.claim(ref, { workerId: 'first', leaseMs: 10000 });
    const result = await actions.dispatch(claim, adapter);
    assert.equal(result.action.state, 'uncertain');
    const replacement = await actions.claim(ref, { workerId: 'retry', leaseMs: 10000 });
    if (replacement) await actions.dispatch(replacement, adapter);
    assert.equal(replacement, null);
    assert.equal(providerCalls, 1);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].effectKey, result.action.id);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
