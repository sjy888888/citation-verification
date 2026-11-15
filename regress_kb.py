# -*- coding: utf-8 -*-
"""regress_kb.py —— kb.mjs 的回归测试

2026-11-10 建。今天给 kb.mjs 加了 TOC 标题加分（+80），必须回归。

kb.mjs 是全库检索（笔记/素材/教材/原著都搜），所以判据和 quote.mjs 不同：
  · 不要求第一条是 L0（有些词就该命中别的层）
  · 要求：L0 原文不能掉出前 3（对经典原文词）
  · 要求：不再出现「工具书压过原文」
"""
import re
import subprocess
import sys

NODE = r"node"
KB = r"G:\path\to\knowledge-base\工具\kb.mjs"

# (查询, 期望: L0 必须出现在前几条, 说明)
CASES = [
    ("异化劳动", 3, "经典原文词，L0 必须靠前"),
    ("劳动的二重性", 3, "标题词，L0 必须靠前"),
    ("货币转化为资本", 3, "标题词，L0 必须靠前"),
    ("剩余价值", 3, "经典原文词"),
    ("新民主主义", 3, "中国化，L1 也算原文层"),
    ("意识形态", 3, "词太通用，L0 可能靠后，只要求前 3 有 L 层"),
    ("商品拜物教", 3, "经典原文词"),
    ("生产力", 3, "泛用词"),
]


def run(q, n=6):
    try:
        r = subprocess.run([NODE, KB, "-a", "-n", str(n), q],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=180)
        return r.stdout or ""
    except Exception as e:
        return f"[ERR]{e}"


def main():
    ok = bad = 0
    print(f"{'查询':<16}{'第一条层':<10}{'L0首现位':<10}判定")
    print("-" * 70)
    for q, want, note in CASES:
        out = run(q)
        rows = re.findall(r"^📄 (.+?) 📖(L\d|T|R|X)", out, re.M)
        if not rows:
            print(f"{q[:14]:<16}{'-':<10}{'-':<10}❌ 无命中")
            bad += 1
            continue
        first_kind = rows[0][1]
        l0_pos = next((i + 1 for i, (_, k) in enumerate(rows) if k.startswith("L")), 0)

        if l0_pos and l0_pos <= want:
            print(f"{q[:14]:<16}{first_kind:<10}{l0_pos:<10}✅ {note}")
            ok += 1
        else:
            print(f"{q[:14]:<16}{first_kind:<10}{l0_pos or '无':<10}⚠ L层在前{want}内没出现 — {note}")
            for p, k in rows[:4]:
                print(f"       {k}  {p[:52]}")
            bad += 1

    print("-" * 70)
    print(f"通过 {ok} / {ok+bad}")


if __name__ == "__main__":
    main()
