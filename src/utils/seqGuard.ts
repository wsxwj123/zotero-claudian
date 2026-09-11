// seqGuard.ts — 在途异步竞态的序号守卫（纯逻辑，node:test 直接跑）。
//
// 场景（R4 复查修-3）：同一份数据由定时器与事件两路触发异步取数，取数耗时不定——
// 先发起的那次可能后完成，把**旧**快照广播出去覆盖新状态（readerContext 就是这条：
// 轮询与切标签 Notifier 都会 pushReaderContext，慢的那次会把旧文献广播回来）。
// 约定：每次取数前 begin() 自增序号并拿到判定函数，await 回来后判定 false 即丢弃本次结果。

export interface SeqGuard {
  /** 开始一次请求：返回「本次是否仍是最新一次」的判定（true = 可以应用结果） */
  begin(): () => boolean;
}

export function createSeqGuard(): SeqGuard {
  let latest = 0;
  return {
    begin(): () => boolean {
      const mine = ++latest;
      return () => mine === latest;
    },
  };
}
