// attachmentChips.ts — R7-J「附件 chips」前端状态（纯函数，不碰 DOM；PLAN-R7 §3.11）。
// 与 mentionPicker 同款形态：chips 归本轮，发送即清；编辑态以新集合为准（可增可删）。
// **UI 永不传路径**（安全修）：chip 里只有「文件名 + 字节数 + 宿主一次性 token 或 base64 字节」，
// 落点与源路径全在宿主侧；token 由宿主原生选择器/落盘回执下发。

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  sanitizeAttachmentName,
} from "../../utils/attachments";
import type { AttachmentPayload } from "./types";

/** 一枚待发送附件（id 供 Preact 做 key 与删除定位） */
export interface PendingAttachment extends AttachmentPayload {
  id: string;
}

export interface AttachmentChipsState {
  items: PendingAttachment[];
  /** 超限/超体积的提示（正常态 null） */
  notice: string | null;
}

export function initialAttachmentChips(): AttachmentChipsState {
  return { items: [], notice: null };
}

let seq = 0;

/** 宿主动作给的一枚原始附件（选择器回执 chip / 粘贴 File）→ chip（名字先净化；
 * 字节数超限的直接不入列并提示）。**路径字段一律不认**。 */
export function pendingAttachment(
  file:
    | {
        name?: unknown;
        sizeBytes?: unknown;
        token?: unknown;
        base64?: unknown;
      }
    | null
    | undefined,
): PendingAttachment {
  seq += 1;
  return {
    id: `att-${seq}`,
    name: sanitizeAttachmentName(file?.name),
    sizeBytes:
      typeof file?.sizeBytes === "number" && Number.isFinite(file.sizeBytes)
        ? file.sizeBytes
        : 0,
    ...(typeof file?.token === "string" && file.token
      ? { token: file.token }
      : {}),
    ...(typeof file?.base64 === "string" && file.base64
      ? { base64: file.base64 }
      : {}),
  };
}

/** 追加一批（去重按「名 + 字节数」——同一张图连粘两次只留一枚）；上限 10，超出提示不落 */
export function attachmentChipsAdd(
  state: AttachmentChipsState,
  files: readonly PendingAttachment[] | null | undefined,
): AttachmentChipsState {
  const items = [...state.items];
  let notice: string | null = null;
  for (const file of Array.isArray(files) ? files : []) {
    if (!file) {
      continue;
    }
    if (file.sizeBytes > ATTACHMENT_MAX_BYTES) {
      notice = `${file.name} 超过单文件 20MB 上限，未加入`;
      continue;
    }
    if (
      items.some((x) => x.name === file.name && x.sizeBytes === file.sizeBytes)
    ) {
      continue;
    }
    if (items.length >= ATTACHMENT_MAX_PER_MESSAGE) {
      notice = `单条最多 ${ATTACHMENT_MAX_PER_MESSAGE} 个附件`;
      continue;
    }
    items.push(file);
  }
  return { items, notice };
}

/** 点 chip 上的 × → 删掉那枚（编辑态增删同一条路径） */
export function attachmentChipRemove(
  state: AttachmentChipsState,
  id: string,
): AttachmentChipsState {
  return { ...state, items: state.items.filter((x) => x.id !== id) };
}

/** 发送后清空（属于本轮） */
export function attachmentChipsClear(): AttachmentChipsState {
  return initialAttachmentChips();
}

/** 编辑态进入：把这个消息当初带的附件塞回 chips（凭据来自落盘回执——UI 手里没有路径） */
export function attachmentChipsSet(
  files: readonly PendingAttachment[],
): AttachmentChipsState {
  return { items: [...files], notice: null };
}

/** 发送载荷：剥掉 UI 用的 id；**只有 token（宿主选择器/回执下发的凭据）或 base64 字节**，
 * 路径字段不存在。两者都没有的条目留给宿主按拒绝处理并回人话原因。 */
export function attachmentPayload(
  state: AttachmentChipsState,
): AttachmentPayload[] {
  return state.items.map(({ name, sizeBytes, token, base64 }) => ({
    name,
    sizeBytes,
    ...(token ? { token } : {}),
    ...(base64 ? { base64 } : {}),
  }));
}

/** chip 上显示的大小（人话：1.2MB / 34KB / 512B） */
export function formatAttachmentSize(sizeBytes: unknown): string {
  const n =
    typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? sizeBytes : 0;
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (n >= 1024) {
    return `${Math.round(n / 1024)}KB`;
  }
  return `${n}B`;
}
