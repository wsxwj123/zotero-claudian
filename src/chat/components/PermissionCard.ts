// 权限卡（M6，§4.6 permissionRequest / permissionResponse）——
// CLI 请求执行工具时弹出，三动作：允许 / 允许并记住（本会话）/ 拒绝。
// 入参摘要与完整入参一律 textContent 渲染（§4.7：不过 HTML 管道，AI/工具入参可能含任意文本）。
// 并行工具调用会同时来多张卡，按队列逐张渲染（各自独立作答）。
import { h } from "preact";
import type { VNode } from "preact";
import type { PendingPermission } from "../lib/chatModel";

export function PermissionCards(props: {
  items: PendingPermission[];
  onRespond: (requestId: string, allow: boolean, remember: boolean) => void;
}): VNode<any> | null {
  if (props.items.length === 0) {
    return null;
  }
  return h(
    "div",
    { class: "perms" },
    props.items.map((item) =>
      h(Card, { key: item.requestId, item, onRespond: props.onRespond }),
    ),
  );
}

function Card(props: {
  item: PendingPermission;
  onRespond: (requestId: string, allow: boolean, remember: boolean) => void;
}): VNode<any> {
  const { item } = props;
  const respond = (allow: boolean, remember: boolean): void =>
    props.onRespond(item.requestId, allow, remember);
  return h(
    "div",
    { class: "perm" },
    h(
      "div",
      { class: "perm-head" },
      "Claude 请求执行工具：",
      h("strong", null, item.tool),
    ),
    h("pre", { class: "perm-summary" }, item.inputSummary),
    h(
      "details",
      { class: "perm-raw" },
      h("summary", null, "完整入参"),
      h("pre", null, safeJson(item.rawInput)),
    ),
    h(
      "div",
      { class: "perm-actions" },
      h(
        "button",
        { class: "perm-allow", onClick: () => respond(true, false) },
        "允许",
      ),
      h(
        "button",
        {
          class: "perm-remember",
          onClick: () => respond(true, true),
          title: "本会话内该规则不再弹卡（下一轮起携带 --allowedTools）",
        },
        "允许并记住",
      ),
      h(
        "button",
        { class: "perm-deny", onClick: () => respond(false, false) },
        "拒绝",
      ),
    ),
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
