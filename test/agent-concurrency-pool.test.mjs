import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentConcurrencyPool } from '../dist/runtime/agent-concurrency-pool.js';

// Let queued microtasks settle so acquire()/reject() state is observable.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function track(promise) {
  const state = { status: 'pending', value: undefined, error: undefined };
  promise.then(
    (value) => { state.status = 'resolved'; state.value = value; },
    (error) => { state.status = 'rejected'; state.error = error; },
  );
  return state;
}

test('AgentConcurrencyPool rejects a non-positive-integer size', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new AgentConcurrencyPool(bad), /positive integer/);
  }
  assert.equal(new AgentConcurrencyPool(1).size, 1);
  assert.equal(new AgentConcurrencyPool(16).size, 16);
});

test('AgentConcurrencyPool bounds concurrency and hands a released permit to the next waiter', async () => {
  const pool = new AgentConcurrencyPool(2);
  const r1 = await pool.acquire();
  const r2 = await pool.acquire();
  // Pool of 2 is now full; the third acquire must wait.
  const third = track(pool.acquire());
  await flush();
  assert.equal(third.status, 'pending');

  r1(); // release one permit -> handed directly to the waiting third acquire
  await flush();
  assert.equal(third.status, 'resolved');
  assert.equal(typeof third.value, 'function');

  // Still full (r2 + third hold both permits); a fourth waits.
  const fourth = track(pool.acquire());
  await flush();
  assert.equal(fourth.status, 'pending');
  r2();
  await flush();
  assert.equal(fourth.status, 'resolved');
});

test('AgentConcurrencyPool acquire rejects immediately for an already-aborted signal', async () => {
  const pool = new AgentConcurrencyPool(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pool.acquire(controller.signal), /aborted/);
  // The permit was never taken: a fresh acquire still succeeds.
  const release = await pool.acquire();
  assert.equal(typeof release, 'function');
});

test('AgentConcurrencyPool settles a queued waiter on abort without leaking its permit', async () => {
  const pool = new AgentConcurrencyPool(1);
  const held = await pool.acquire(); // exhaust the single permit
  const controller = new AbortController();
  const queued = track(pool.acquire(controller.signal));
  await flush();
  assert.equal(queued.status, 'pending');

  controller.abort();
  await flush();
  assert.equal(queued.status, 'rejected');

  // The aborted waiter must not have captured the permit: releasing the holder
  // returns it to the pool, so the next acquire succeeds.
  held();
  const next = track(pool.acquire());
  await flush();
  assert.equal(next.status, 'resolved');
});

test('AgentConcurrencyPool does not leak a permit to an aborted waiter ahead of a live one', async () => {
  // The grant-race both design reviewers flagged: when a permit is released, it must
  // skip a waiter that has already aborted and reach the next live waiter (or the pool),
  // never vanish. Pool size 1, holder + two queued waiters, abort the first waiter.
  const pool = new AgentConcurrencyPool(1);
  const held = await pool.acquire();

  const abortedController = new AbortController();
  const abortedWaiter = track(pool.acquire(abortedController.signal));
  const liveWaiter = track(pool.acquire());
  await flush();
  assert.equal(abortedWaiter.status, 'pending');
  assert.equal(liveWaiter.status, 'pending');

  abortedController.abort();
  await flush();
  assert.equal(abortedWaiter.status, 'rejected');

  // Release: the permit must reach the live waiter, not follow the aborted one into the void.
  held();
  await flush();
  assert.equal(liveWaiter.status, 'resolved', 'released permit must reach the live waiter');

  // And exactly one permit is outstanding: a fresh acquire blocks until the live waiter releases.
  const afterLive = track(pool.acquire());
  await flush();
  assert.equal(afterLive.status, 'pending');
  liveWaiter.value();
  await flush();
  assert.equal(afterLive.status, 'resolved');
});

test('AgentConcurrencyPool release is idempotent', async () => {
  const pool = new AgentConcurrencyPool(1);
  const release = await pool.acquire();
  release();
  release(); // second call must not add a phantom permit
  // If release double-counted, two concurrent acquires would both resolve.
  const a = await pool.acquire();
  const b = track(pool.acquire());
  await flush();
  assert.equal(b.status, 'pending', 'a double release must not inflate the permit count');
  a();
  await flush();
  assert.equal(b.status, 'resolved');
});
