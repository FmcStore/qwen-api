// Unit coverage for the worker-pool waiter logic (no Chrome launched — uses
// the __pool test hook). Pins two behaviors that once hung forever:
//
//   1. A spurious wake (wake promised capacity that vanished before the waiter
//      ran) must REQUEUE the waiter, not dereference undefined.
//   2. A wake on an EMPTY pool (every recycle failed) must REJECT the waiter,
//      not leave the queued request pending until process death.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __pool } from "../browser.js";

function resetPool() {
  __pool.workers.length = 0;
  __pool.waiters.length = 0;
}

test("spurious wake requeues the waiter instead of crashing it", async () => {
  resetPool();
  try {
    const fake = { id: 90, context: null, page: null, busy: true };
    __pool.workers.push(fake);

    let resolved = null;
    const p = __pool.acquireWorker().then((w) => (resolved = w));
    assert.equal(__pool.waiters.length, 1, "acquire should have queued one waiter");

    // Simulate the failed-recycle race: wakeNextWaiter fires while every
    // remaining worker is still busy. (Shift-then-call, like the real thing.)
    const spurious = __pool.waiters.shift();
    spurious();
    assert.equal(__pool.waiters.length, 1, "spurious wake dropped the waiter");
    assert.equal(resolved, null, "waiter resolved without a free worker");

    // The real release arrives later — the requeued waiter must still get it.
    fake.busy = false;
    __pool.releaseWorker(fake);
    await p;
    assert.equal(resolved, fake);
  } finally {
    resetPool();
  }
});

test("wake on an empty pool rejects instead of hanging forever", async () => {
  resetPool();
  try {
    const p = __pool.acquireWorker();
    assert.equal(__pool.waiters.length, 1);

    // Simulate recycleWorker's failure path: the dead worker was spliced out,
    // leaving zero workers, and wakeNextWaiter() shifts + invokes the waiter.
    __pool.workers.length = 0;
    const stranded = __pool.waiters.shift();
    stranded();

    await assert.rejects(p, /worker pool exhausted/);
    assert.equal(__pool.waiters.length, 0, "rejected waiter left in the queue");
  } finally {
    resetPool();
  }
});
