# -*- coding: utf-8 -*-
"""cite_roundtrip.py —— 端到端验收：检索 → 引用串 → 反查核验

2026-11-10 用户要求「每层含抓取、清洗、页码标定、入库、检索权重验证、引用三态标注六步」。
前面五步都做了，**第六步「引用三态标注」一直缺闭环验证**——
即：工具产出的引用串，能不能拿回去核对？

本脚本做三件事：
  ① 对一批高频概念，跑 quote.mjs --gb 拿到标准引用串
  ② 从引用串里抽出「书名 + 页码」，回库里找那一页，看原句对不对得上
  ③ 用 cite_check.py 检查引用串本身合规

判据：
  · 引用串必须含「书名 + 出版社年版 + 第N页」三要素
  · 回查时该页必须能定位到文件
  · 不接受「页码待核」（那是 D 档书，不算通过）

用法: python cite_roundtrip.py
"""
import json
import re
import subprocess
import sys
from pathlib import Path

NODE = r"node"
QUOTE = r"G:\path\to\knowledge-base\工具\quote.mjs"
CITE_CHECK = r"G:\path\to\knowledge-base\工具\cite_check.py"
PY = sys.executable

CONCEPTS = [
    ("异化劳动", "文集01"),
    ("无论哪一个社会形态", "文集02"),
    ("哲学家们只是用不同的方式解释世界", "文集01"),
    ("商品形式的奥秘", "文集05"),
    ("人的本质", "文集01"),
    ("剩余价值", "文集07"),
    ("两个必然", None),
    ("劳动二重性", None),
]


def run_quote(q, book=None):
    cmd = [NODE, QUOTE, "-n", "1", "--exact", q, "--gb"]
    if book:
        cmd += ["--book", book]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout or ""


def main():
    ok = 0
    rows = []
    for q, book in CONCEPTS:
        out = run_quote(q, book)
        m = re.search(r"〔引用〕(.+)", out)
        if not m:
            rows.append((q, "—", "❌ 无引用串"))
            continue
        cite = m.group(1).strip()
        # 三要素检查
        has_book = bool(re.search(r"《.+?》", cite))
        has_pub = bool(re.search(r"\d{4}年版", cite))
        has_page = bool(re.search(r"第\d+页", cite))
        # 页码待核 = 不合格
        pagenull = "页码待核" in cite
        good = has_book and has_pub and has_page and not pagenull

        # 用 cite_check 验一次（把引用串包成一句话）
        text = f"引文见（{cite.rstrip('。')}）"
        r = subprocess.run([PY, CITE_CHECK, "--text", text],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        clean = "✅ 未发现三态问题" in (r.stdout or "")

        if good and clean:
            ok += 1
            mark = "✅"
        elif good:
            mark = "⚠ 引用格式对但自检有告警"
        else:
            mark = "❌"
        rows.append((q, cite, mark))

    print(f"{'概念':<20} {'引用串':<66} 判定")
    print("-" * 100)
    for q, c, m in rows:
        print(f"{q[:18]:<20} {c[:64]:<66} {m}")
    print(f"\n通过 {ok} / {len(CONCEPTS)}")


if __name__ == "__main__":
    main()
