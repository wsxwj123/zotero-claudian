// 单测 — R4 复查修-3：在途取数的序号守卫（readerContext 轮询/Notifier 两路异步取数，
// 先发起的可能后完成——旧快照不得覆盖新状态）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeqGuard } from "../../src/utils/seqGuard.ts";

test("seqGuard: 乱序完成——慢的旧调用后回来被丢弃，最新一次生效", async () => {
  const guard = createSeqGuard();
  const applied: string[] = [];
  const slowOld = (async () => {
    const isLatest = guard.begin(); // ① 先发起（取的是旧文献）
    await new Promise((r) => setTimeout(r, 20));
    if (isLatest()) {
      applied.push("旧快照");
    }
  })();
  const fastNew = (async () => {
    const isLatest = guard.begin(); // ② 后发起（取的是新文献）
    await new Promise((r) => setTimeout(r, 1));
    if (isLatest()) {
      applied.push("新快照");
    }
  })();
  await Promise.all([slowOld, fastNew]);
  assert.deepEqual(
    applied,
    ["新快照"],
    "旧快照后到却生效了（把新文献覆盖回旧的）",
  );
});

test("seqGuard: 单次调用恒为最新；串行两次后只有最后一次有效", async () => {
  const guard = createSeqGuard();
  const first = guard.begin();
  assert.equal(first(), true, "单次调用应可应用结果");
  const second = guard.begin();
  assert.equal(first(), false, "新一次开始后，前一次的结果作废");
  assert.equal(second(), true);
});
