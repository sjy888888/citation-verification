# -*- coding: utf-8 -*-
"""verify_all_cites.py —— 把库里所有 L0 经典引文批量过一遍复检

2026-11-10 建。理由：前面只手工核过 3–5 条，用户问「能直接用在论文上吗」，
我只能说「核过的那几条能」。现在把 L0 里高频引用的名句批量核一遍。

做法：
  ① 准备一批「确定出自某书某页」的经典原句（不用模糊说法，只用能定位的）
  ② 逐条跑 cite_pipeline（检索→引用串→核页码→核文字）
  ③ 汇总：多少条全绿、多少条有问题、问题在哪

**只报事实。核不了的写「核不了」，不写「通过」。**
"""
import re
import subprocess
import sys
from pathlib import Path

DIR = Path(r"G:\path\to\knowledge-base\工具")

# 每条：可检索的原文片段（必须是原句，不是概括）
QUOTES = [
    "哲学家们只是用不同的方式解释世界，问题在于改变世界",
    "无论哪一个社会形态，在它所能容纳的全部生产力发挥出来以前，是决不会灭亡的",
    "资产阶级的灭亡和无产阶级的胜利是同样不可避免的",
    "人的本质不是单个人所固有的抽象物，在其现实性上，它是一切社会关系的总和",
    "理论一经掌握群众，也会变成物质力量",
    "异化劳动和私有财产",
    "商品形式的奥秘不过在于",
    "宗教是人民的鸦片",
    "批判的武器当然不能代替武器的批判",
    "一切等级的和固定的东西都烟消云散了",
    "至今一切社会的历史都是阶级斗争的历史",
    "无产阶级在这个革命中失去的只是锁链",
    "从后思索",
    "社会生活在本质上是实践的",
    "不是意识决定生活，而是生活决定意识",
    "任何一个民族，如果停止劳动，不用说一年，就是几个星期，也要灭亡",
]


def run(cmd, timeout=180):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout,
                           cwd=str(DIR))
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return f"[ERR]{e}"


def main():
    ok = warn = bad = skip = 0
    rows = []
    for q in QUOTES:
        out = run([sys.executable, str(DIR / "cite_pipeline.py"), q])
        cite = ""
        m = re.search(r"② 引用串：(.+)", out)
        if m:
            cite = m.group(1).strip()
        page_ok = "✅" in (re.search(r"③ 核页码：(.)", out).group(0) if re.search(r"③ 核页码：(.)", out) else "")
        text_ok = "✅" in (re.search(r"④ 核文字：(.)", out).group(0) if re.search(r"④ 核文字：(.)", out) else "")
        found = "① 检索：✅" in out

        if not found:
            verdict, color = "库内无此句", "❌"
        elif page_ok and text_ok:
            verdict, color = "页码+文字双核通过", "✅"
            ok += 1
        elif page_ok and not text_ok:
            verdict, color = "页码过，文字待核", "⚠"
            warn += 1
        elif not page_ok:
            verdict, color = "页码核不了", "⚠"
            warn += 1
        else:
            verdict, color = "?", "?"
        if not found:
            bad += 1
        rows.append((color, q, verdict, cite))

    print(f"\n{'='*76}")
    print(f"核了 {len(QUOTES)} 条 L0 经典引文")
    print(f"  ✅ 双核通过  {ok}")
    print(f"  ⚠ 部分通过  {warn}")
    print(f"  ❌ 库内无此句 {bad}")
    print("=" * 76)
    for color, q, v, cite in rows:
        print(f"{color} {q[:30]:<32} {v}")
        if cite:
            print(f"      {cite[:88]}")


if __name__ == "__main__":
    main()
