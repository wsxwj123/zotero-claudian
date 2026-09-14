// 单测 — R17 / P4：`tabIdOf(body)` 的身份回落链（宿主内部纯函数）
//
// 契约来源：.devflow/INTERFACE-R17.md §1.1「身份回落链（顺序即优先级）」：
// 层1 item-details.tabID → 层2 item-pane-custom-section.tabID → 层3 item-details.dataset.tabId → null。
// 单独成文件：该导出在修复前不存在，import 失败不应盖住其它用例的红绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { tabIdOf } from "../../src/modules/sections.ts";

/** 造一个只实现 closest() 的假 body：按选择器返回指定祖先 */
function bodyWith(ancestors: Record<string, unknown>): Element {
  return {
    closest: (selector: string) => ancestors[selector] ?? null,
  } as unknown as Element;
}

const details = (props: Record<string, unknown>) => ({ ...props });

test("T-P4-d1 🔴 只有层1（item-details.tabID）→ 取层1", () => {
  const body = bodyWith({ "item-details": details({ tabID: "tab-1" }) });
  assert.equal(tabIdOf(body), "tab-1");
});

test("T-P4-d2 🔴 只有层2（item-pane-custom-section.tabID）→ 取层2", () => {
  const body = bodyWith({
    "item-pane-custom-section": details({ tabID: "tab-2" }),
  });
  assert.equal(tabIdOf(body), "tab-2");
});

test("T-P4-d3 🔴 只有层3（item-details.dataset.tabId）→ 取层3", () => {
  const body = bodyWith({
    "item-details": details({ dataset: { tabId: "tab-3" } }),
  });
  assert.equal(tabIdOf(body), "tab-3");
});

test("T-P4-d4 🔴 三层都没有 → 返回 null", () => {
  assert.equal(tabIdOf(bodyWith({})), null);
});

test("T-P4-d5 🔴 body 为 null → 返回 null（不抛错）", () => {
  assert.equal(tabIdOf(null), null);
});

test("T-P4-d6 🔴 层1 与层2 同时存在 → 按优先级取层1", () => {
  const body = bodyWith({
    "item-details": details({ tabID: "tab-1", dataset: { tabId: "tab-3" } }),
    "item-pane-custom-section": details({ tabID: "tab-2" }),
  });
  assert.equal(tabIdOf(body), "tab-1");
});

test("T-P4-d7 🔴 层1 元素在但 tabID 为空串 → 回落到层2", () => {
  const body = bodyWith({
    "item-details": details({ tabID: "" }),
    "item-pane-custom-section": details({ tabID: "tab-2" }),
  });
  assert.equal(tabIdOf(body), "tab-2");
});
