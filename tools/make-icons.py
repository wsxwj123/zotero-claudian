#!/usr/bin/env python3
"""生成插件图标（自有美术资源，替代模板自带 favicon）。

产物（PNG，RGBA，透明背景）：
  addon/content/icons/favicon.png        32x32  → manifest icons["96"]
  addon/content/icons/favicon@0.5x.png   16x16  → manifest icons["48"]

图形：圆角对话气泡（聊天类插件的通用隐喻），单色填充。
只用标准库（zlib + struct），无第三方依赖；改图形/颜色改下面的常量即可。

用法：python3 tools/make-icons.py
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

ICON_DIR = Path(__file__).resolve().parent.parent / "addon" / "content" / "icons"
FILL = (217, 119, 87)  # #D97757
SIZES = {"favicon.png": 32, "favicon@0.5x.png": 16}
SS = 8  # 超采样倍数：几何覆盖率 -> 抗锯齿

# 图形几何（单位坐标 0..1；气泡本体 + 左下尾巴）
BOX = (0.08, 0.12, 0.92, 0.74)  # x0, y0, x1, y1
RADIUS = 0.16
TAIL = ((0.18, 0.70), (0.52, 0.70), (0.22, 0.94))  # 三角形顶点


def inside(x: float, y: float) -> bool:
    """点是否落在气泡内（圆角矩形 ∪ 尾巴三角形）。"""
    x0, y0, x1, y1 = BOX
    if x0 <= x <= x1 and y0 <= y <= y1:
        # 圆角：把点夹到「内缩矩形」上，离夹取点超过半径即在圆角外
        cx = min(max(x, x0 + RADIUS), x1 - RADIUS)
        cy = min(max(y, y0 + RADIUS), y1 - RADIUS)
        return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS**2
    return point_in_triangle(x, y, *TAIL)


def point_in_triangle(px, py, a, b, c) -> bool:
    """质心坐标判内外；不依赖三角形顶点绕向。"""
    d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(d) < 1e-12:
        return False
    wa = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d
    wb = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d
    wc = 1.0 - wa - wb
    return wa >= 0 and wb >= 0 and wc >= 0


def render(size: int) -> bytes:
    """逐像素超采样出 RGBA 行数据（PNG 过滤类型 0）。"""
    rows = b""
    step = 1.0 / (size * SS)
    for py in range(size):
        line = bytearray()
        for px in range(size):
            hits = 0
            for sy in range(SS):
                y = (py * SS + sy + 0.5) * step
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) * step
                    if inside(x, y):
                        hits += 1
            alpha = round(255 * hits / (SS * SS))
            line += bytes((*FILL, alpha))
        rows += b"\x00" + bytes(line)
    return rows


def png_bytes(size: int, raw: bytes) -> bytes:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> int:
    for name, size in SIZES.items():
        data = png_bytes(size, render(size))
        (ICON_DIR / name).write_bytes(data)
        print(f"wrote {ICON_DIR / name} ({len(data)} bytes, {size}x{size})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
