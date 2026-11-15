# -*- coding: utf-8 -*-
"""verify_cites_batch.py —— 分批核验经典引文（可断点续跑）

2026-11-10 建。上一版 verify_all_cites.py 一次跑 16 条会超时（每条要扫全库 10 秒 + 开 PDF）。

本版：
  · 每次只跑 N 条（默认 4）
  · 结果写进 JSON，已核过的跳过
  · 可以反复跑，直到核完
"""
import json
import re
import subprocess
import sys
from pathlib import Path

DIR = Path(r"G:\path\to\knowledge-base\工具")
OUT = DIR / "_verify_cites_result.json"

QUOTES = [
    "哲学家们只是用不同的方式解释世界，问题在于改变世界",
    "无论哪一个社会形态，在它所能容纳的全部生产力发挥出来以前，是决不会灭亡的",
    "资产阶级的灭亡和无产阶级的胜利是同样不可避免的",
    "人的本质不是单个人所固有的抽象物，在其现实性上，它是一切社会关系的总和",
    "理论一经掌握群众，也会变成物质力量",
    "宗教是人民的鸦片",
    "批判的武器当然不能代替武器的批判",
    "至今一切社会的历史都是阶级斗争的历史",
    "社会生活在本质上是实践的",
    "不是意识决定生活，而是生活决定意识",
    "任何一个民族，如果停止劳动，不用说一年，就是几个星期，也要灭亡",
    "异化劳动和私有财产",
    "商品形式的奥秘不过在于",
]


def load():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    res = load()
    todo = [q for q in QUOTES if q not in res]
    print(f"已核 {len(res)} 条，待核 {len(todo)} 条，本轮跑 {min(n, len(todo))} 条\n")
    if not todo:
        print("全部核完")
        return

    for q in todo[:n]:
        try:
            r = subprocess.run([sys.executable, str(DIR / "cite_pipeline.py"), q],
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=240, cwd=str(DIR))
            out = (r.stdout or "") + (r.stderr or "")
        except subprocess.TimeoutExpired:
            out = "[TIMEOUT]"

        cite = (re.search(r"② 引用串：(.+)", out).group(1).strip()
                if re.search(r"② 引用串：(.+)", out) else "")
        found = "① 检索：✅" in out
        page_ok = "③ 核页码：✅" in out
        text_ok = "④ 核文字：✅" in out

        if not found:
            v = "库内无此句"
        elif page_ok and text_ok:
            v = "双核通过"
        elif page_ok:
            v = "页码过，文字待核"
        elif "无法核" in out:
            v = "核不了（无PDF）"
        else:
            v = "页码核不了"

        res[q] = {"verdict": v, "cite": cite, "raw_len": len(out)}
        print(f"  {v:<14} {q[:34]}")
        if cite:
            print(f"      {cite[:86]}")

    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")

    ok = sum(1 for v in res.values() if v["verdict"] == "双核通过")
    print(f"\n累计：双核通过 {ok} / {len(res)}，已存到 {OUT.name}")


if __name__ == "__main__":
    main()
