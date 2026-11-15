# -*- coding: utf-8 -*-
"""regress_quote.py —— quote.mjs 改动后的回归测试

2026-11-10 建。今天给 quote.mjs 加了 TOC 标题索引（把章节标题插到最前）。
凡改动排序，必须回归——否则可能悄悄改坏原来正确的那些。

本脚本对一批「已知正确答案」的查询逐条跑，比对：
  · 第一条是不是 L0 原文
  · 引用的页码对不对（如果期望值给了）
"""
import json
import re
import subprocess
import sys

NODE = r"node"
QUOTE = r"G:\path\to\knowledge-base\工具\quote.mjs"

# (查询, 期望第一条含有的关键词, 期望页码或 None)
# 2026-11-10 二修：**期望值只比对页码和层，不比 label**。
#   一版把「篇名关键词」写进期望，但 r.label 是**书名**（《马克思恩格斯文集》第1卷），
#   篇名在 hit.text 的〔篇〕里，于是 7 条全是误报，掩盖了真问题。
# 格式：(查询, 期望页码 或 None, 是否必须标题命中)
CASES = [
    ("哲学家们只是用不同的方式解释世界", "502", False),
    ("资产阶级的灭亡和无产阶级的胜利是同样不可避免的", "43", False),
    ("商品形式的奥秘不过在于", "89", False),
    ("人的本质不是单个人所固有的抽象物", "501", False),
    ("批判的武器当然不能代替武器的批判", "763", False),
    ("社会生活在本质上是实践的", "501", False),
    # 标题类：必须命中〔章节标题〕
    # 2026-11-11 修期望值：原写 "155"，但那是**文集01** 的「德意志意识形态」页，
    #   不是《异化劳动和私有财产》所在页。选集01 p49 才是真正的篇名位置
    #   （实测 p49 段首即「［异化劳动和私有财产］」）。
    #   原来的 155 是旧状态下的误命中，被当成了标准答案。
    ("异化劳动和私有财产", "49", True),
    ("劳动的二重性", "54", True),
    ("货币转化为资本", "171", True),
    # 短概念词：必须走正文命中，不能被标题抢
    ("异化劳动", "56", False),
    ("剩余价值", None, False),
    ("生产力", None, False),
]


def run(q):
    try:
        r = subprocess.run([NODE, QUOTE, "-n", "1", "--exact", q, "--json"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=150)
        return json.loads(r.stdout or "{}")
    except Exception as e:
        return {"_err": str(e)}


def main():
    ok = bad = 0
    print(f"{'查询':<34}{'第一条':<8}{'页码':<8}判定")
    print("-" * 78)
    for q, page, want_title in CASES:
        j = run(q)
        shown = j.get("shown") or []
        if not shown:
            print(f"{q[:32]:<34}{'-':<8}{'-':<8}❌ 无命中")
            bad += 1
            continue
        r0 = shown[0]
        label = str(r0.get("label") or "")
        h0 = (r0.get("hits") or [{}])[0]
        pg = str(h0.get("page") or "")
        kind = str(r0.get("kind") or "")[:4]

        raw = str(h0.get("text") or "")
        is_title_hit = "〔章节标题〕" in raw
        kw_ok = (not want_title) or is_title_hit
        if not want_title:
            kw_ok = not is_title_hit        # 短词不该被标题抢
        pg_ok = (page is None) or (pg == page)
        is_l0 = kind.startswith("L0")

        if kw_ok and pg_ok and is_l0:
            print(f"{q[:32]:<34}{kind:<8}{pg:<8}✅")
            ok += 1
        else:
            why = []
            if not is_l0:
                why.append(f"非L0({kind})")
            if not kw_ok:
                why.append("标题命中不符期望" if want_title else "被标题抢了")
            if not pg_ok:
                why.append(f"页码 {pg}≠{page}")
            print(f"{q[:32]:<34}{kind:<8}{pg:<8}⚠ {'; '.join(why)}")
            print(f"     第一条：{label[:60]}")
            bad += 1

    print("-" * 78)
    print(f"通过 {ok} / {ok+bad}")


if __name__ == "__main__":
    main()
