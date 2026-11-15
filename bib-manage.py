#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bib-manage.py — 轻量 BibTeX 文献库管理（本地，无依赖）。

用法：
    python bib-manage.py add        # 交互式添加一条文献
    python bib-manage.py list       # 列出所有条目（标题 / 作者 / 年份）
    python bib-manage.py search 关键词   # 按标题/作者/年份检索
    python bib-manage.py dedupe     # 按标题查重，报告疑似重复
    python bib-manage.py export 7714   # 导出引用格式（7714 / apa）

文献库文件：G:\\path\\to\\knowledge-base\\文献库\\references.bib
"""

import re
import sys
from pathlib import Path

BIB = Path(__file__).resolve().parent.parent / "文献库" / "references.bib"


def parse_bib(text: str):
    """逐行解析 .bib 文本，返回条目列表，每条是 {key, type, fields}。"""
    entries = []
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("%"):
            continue
        if line.startswith("@"):
            m = re.match(r'@(\w+)\s*\{\s*([^,]+)\s*,', line)
            if m:
                current = {"key": m.group(2).strip(), "type": m.group(1).lower(), "fields": {}}
                entries.append(current)
            continue
        if current is not None:
            if line == "}":
                current = None
                continue
            m = re.match(r'(\w+)\s*=\s*\{?(.*?)\}?\s*,?$', line)
            if m:
                current["fields"][m.group(1).lower()] = m.group(2).strip()
    return entries


def load():
    if not BIB.exists():
        return []
    return parse_bib(BIB.read_text(encoding="utf-8"))


def save(entries):
    lines = []
    for e in entries:
        lines.append(f"@{e['type']}{{{e['key']},")
        for name, val in e["fields"].items():
            lines.append(f"  {name} = {{{val}}},")
        lines.append("}\n")
    BIB.write_text("\n".join(lines), encoding="utf-8")


def make_key(fields):
    author = fields.get("author", fields.get("editor", "unknown"))
    surname = author.split(",")[0].split(" ")[-1].strip() if author else "unknown"
    year = fields.get("year", fields.get("date", "0000"))[:4]
    return f"{surname}{year}"


def add_interactive():
    print("添加文献（回车跳过可选字段）：")
    etype = input("类型 [book/article/incollection/phdthesis/misc]: ").strip() or "misc"
    author = input("作者 (英文用 '姓, 名' 或 '名 姓'): ").strip()
    title = input("标题: ").strip()
    year = input("年份: ").strip()
    extra = input("其他 (如 出版社=XX, 期刊=XX, 用逗号分隔): ").strip()
    if not title:
        print("标题不能为空，取消。")
        return

    fields = {}
    if author:
        fields["author"] = author
    fields["title"] = title
    if year:
        fields["year"] = year
    for part in [p for p in extra.replace("，", ",").split(",") if p.strip()]:
        if "=" in part:
            k, v = part.split("=", 1)
            fields[k.strip().lower()] = v.strip()

    key = make_key(fields)
    entries = load()
    entries.append({"key": key, "type": etype, "fields": fields})
    save(entries)
    print(f"已添加：{key}  ({title})")


def list_entries(entries):
    if not entries:
        print("文献库为空。")
        return
    for e in entries:
        f = e["fields"]
        print(f"  [{e['key']}] ({f.get('year','?')}) {f.get('author','?')} — {f.get('title','?')}")


def search(entries, kw):
    hits = [e for e in entries if kw.lower() in
            (e["fields"].get("title", "") + " " + e["fields"].get("author", "")).lower()]
    if not hits:
        print(f"没有匹配「{kw}」的条目。")
        return
    print(f"找到 {len(hits)} 条：")
    list_entries(hits)


def dedupe(entries):
    seen = {}
    for e in entries:
        t = e["fields"].get("title", "").strip().lower()
        seen.setdefault(t, []).append(e)
    dup = {t: es for t, es in seen.items() if len(es) > 1 and t}
    if not dup:
        print("没有疑似重复条目。")
        return
    for t, es in dup.items():
        print(f"重复标题「{es[0]['fields'].get('title')}」：{', '.join(e['key'] for e in es)}")


def export(entries, style):
    for e in entries:
        f = e["fields"]
        author = f.get("author", f.get("editor", "佚名"))
        title = f.get("title", "")
        year = f.get("year", f.get("date", "无年份"))
        if style == "apa":
            print(f"{author} ({year}). {title}.")
        else:  # 7714 风格（简版）
            print(f"{author}. {title}[{e['type'].upper()}]. {year}.")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    entries = load()
    if cmd == "add":
        add_interactive()
    elif cmd == "list":
        print(f"共 {len(entries)} 条：")
        list_entries(entries)
    elif cmd == "search":
        if len(sys.argv) < 3:
            print("用法：python bib-manage.py search 关键词")
            return
        search(entries, sys.argv[2])
    elif cmd == "dedupe":
        dedupe(entries)
    elif cmd == "export":
        style = sys.argv[2] if len(sys.argv) > 2 else "7714"
        export(entries, style)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
