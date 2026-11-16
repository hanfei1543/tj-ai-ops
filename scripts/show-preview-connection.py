#!/usr/bin/env python3
"""Preview 连接信息交接（仅真实交互终端，不落盘、不写日志、不外发）。

用途：Windows 用户通过既有 SSH 隧道登录 VPS 后，在**自己的终端**里手动取得
Stage25 Preview V2 的六项配置值，再回到 Windows 的 01_Configure.cmd /
02_Login_Once.cmd 手动输入。密码只在 Configure/Login 的 -AsSecureString 提示里输入，
不在 Windows 保存明文，也不经聊天/Telegram/ZIP 传递。

安全约束（刻意写死）：
  * stdin 与 stdout 必须都是 TTY；管道/重定向/自动化采集一律拒绝退出。
  * 必须手动输入确认词；不提供 --yes 等非交互开关。
  * 只读本地 credentials/windows-preview-config.env，不写文件、不联网、不记录日志。
  * 不在源码里内嵌任何 URL / key / 密码。
"""

import os
import sys

ENV_PATH = "/home/hermes/projects/TJ-AI-Ops/credentials/windows-preview-config.env"

# 六项：URL / ANON KEY / SCHEMA / EMAIL / PASSWORD / QUEUE_ROOT
FIELDS = [
    ("SUPABASE_URL", "Supabase URL"),
    ("SUPABASE_ANON_KEY", "Supabase anon/publishable key"),
    ("SUPABASE_SCHEMA", "Schema（必须是 tj_preview）"),
    ("WORKER_EMAIL", "Auth worker email"),
    ("WORKER_PASSWORD", "Auth worker password"),
    ("QUEUE_ROOT", "Windows Queue 根目录"),
]
CONFIRM_WORD = "SHOW"
DEFAULT_QUEUE_ROOT = r"C:\Users\Administrator\Desktop\operation\PO_Queue"
FIELD_ALIASES = {
    "SUPABASE_URL": "TJ_SUPABASE_URL",
    "SUPABASE_ANON_KEY": "TJ_SUPABASE_ANON_KEY",
    "SUPABASE_SCHEMA": "TJ_ACK_SCHEMA",
    "WORKER_EMAIL": "TJ_ACK_WORKER_EMAIL",
    "WORKER_PASSWORD": "TJ_ACK_WORKER_PASSWORD",
    "ACK_RPC": "TJ_ACK_RPC",
}


def refuse(message: str) -> int:
    sys.stderr.write("REFUSED: " + message + "\n")
    sys.stderr.flush()
    return 1


def parse_env(text: str):
    values = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def resolve_config(source: dict[str, str]) -> dict[str, str]:
    """Resolve existing names in memory only; errors contain names, never values."""
    values = dict(source)
    for canonical, alias in FIELD_ALIASES.items():
        current, existing = source.get(canonical, ""), source.get(alias, "")
        if current and existing and current != existing:
            raise ValueError("凭据字段冲突：%s / %s" % (canonical, alias))
        values[canonical] = current or existing
    values["QUEUE_ROOT"] = source.get("QUEUE_ROOT") or DEFAULT_QUEUE_ROOT
    missing = [key for key, _ in FIELDS if not values.get(key)]
    if not values.get("ACK_RPC"):
        missing.append("ACK_RPC")
    if missing:
        raise ValueError("凭据文件缺少字段：" + ", ".join(missing))
    if values["SUPABASE_SCHEMA"] != "tj_preview":
        raise ValueError("SUPABASE_SCHEMA 必须是 tj_preview（未显示配置值）")
    if values["ACK_RPC"] != "tj_po_ack_ingest":
        raise ValueError("ACK_RPC 必须是 tj_po_ack_ingest（未显示配置值）")
    return values


def main() -> int:
    # 防工具/日志/重定向抓取：只允许真实交互终端。
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return refuse(
            "必须在真实交互终端运行（ssh -t）。本脚本拒绝管道、重定向或自动化采集，"
            "也不会把凭据写入任何文件或日志。"
        )

    print("即将显示 Preview 连接凭据（6 项）。请确认屏幕只有你本人可见，且当前 SSH 会话可信。")
    print("密码不会保存在 Windows 明文文件中；稍后由 Configure/Login 以 -AsSecureString 输入。")
    try:
        answer = input("确认请输入 %s（其他任何输入将取消）：" % CONFIRM_WORD)
    except (EOFError, KeyboardInterrupt):
        return refuse("已取消")
    if answer.strip() != CONFIRM_WORD:
        return refuse("已取消（未显示任何凭据）")

    if not os.path.isfile(ENV_PATH):
        return refuse("找不到凭据文件：%s（请联系主脑生成，勿在聊天中索取）" % ENV_PATH)

    try:
        with open(ENV_PATH, "r", encoding="utf-8") as fh:
            values = resolve_config(parse_env(fh.read()))
    except (OSError, UnicodeError):
        return refuse("读取凭据文件失败（未显示任何凭据）")
    except ValueError as error:
        return refuse(str(error))

    print("")
    print("=== Stage25 Preview V2 连接信息（仅本次终端显示）===")
    for key, label in FIELDS:
        print("%s (%s): %s" % (label, key, values[key]))
    print("=== 结束：请直接在 Windows Configure/Login 提示符输入，不要粘贴到聊天/工单 ===")
    print("提示：URL/ANON/EMAIL 由 01_Configure.cmd 输入；PASSWORD 由 02_Login_Once.cmd 以 -AsSecureString 输入；")
    print("      SCHEMA 固定 tj_preview（脚本已写死并 fail closed）；QUEUE_ROOT 使用默认值或显式 -QueueRoot。")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
