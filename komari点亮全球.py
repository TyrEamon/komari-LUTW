#!/usr/bin/env python3
"""
komari 点亮全球 —— 注册一批假探针，让它们伪装成不同国家，把面板地图"点满"。

【读 komari / komari-agent 源码后得到的原理】
  1) 注册（每调一次建一个客户端）:
       POST {server}/api/clients/register?name=XXX
       Header: Authorization: Bearer <AutoDiscoveryKey>
       -> 返回 {"data": {"uuid": ..., "token": ...}}
  2) 上报（v2 JSON-RPC，纯 HTTP，不需要 protobuf/Worker）:
       POST {server}/api/clients/v2/rpc?token=<token>
       - agent.basicInfo  写静态信息，其中 region 字段 = 国旗 emoji
       - agent.report     周期性上报负载，用来保持"在线"（POST 在线 TTL=35s）
  3) 关键点（为什么能直接指定国家）:
       服务端 appendClientRegionFromGeoIP() 只有在 GeoIP 能解析出
       我们上报的 ipv4/ipv6 时，才会用解析结果覆盖 region。
       我们把 ipv4 填成 192.0.2.1（RFC5737 TEST-NET-1，任何 GeoIP 库都无法定位），
       于是我们手动塞进去的 region emoji 不会被覆盖。
       => 不用关掉面板的 GeoIP，也完全不影响你真实的服务器。

  与哪吒版最大的不同: komari 探针协议是普通 JSON over HTTP，
  所以【不需要】Cloudflare Worker 中转，一个脚本直连面板就行。

用法:
  # 首次: 注册 200 个假探针并开始保活（会生成 komari-fake-state.json）
  python komari点亮全球.py --server https://komari.example.com --adkey 你的自动发现密钥 --new

  # 之后: 复用已注册的探针，只保活
  python komari点亮全球.py --server https://komari.example.com

  # 只想点亮指定国家:
  python komari点亮全球.py --server https://x --adkey k --new --countries US,JP,DE,AQ,FM
"""

import argparse
import json
import logging
import random
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

STATE_FILE = Path(__file__).with_name("komari-fake-state.json")
JSONRPC = "2.0"
BOGON_IP = "192.0.2.1"  # RFC5737, GeoIP 永远无法定位 -> 保护我们手填的 region

# ISO 3166-1 alpha-2，覆盖 ~200 个国家/地区（含经典的 AQ 南极洲）。
COUNTRIES = (
    "AD AE AF AG AL AM AO AR AT AU AW AZ AQ BA BB BD BE BF BG BH BI BJ BN BO "
    "BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK "
    "DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GL GM GN GQ GR GT "
    "GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN "
    "KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM "
    "MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH "
    "PK PL PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO "
    "SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ "
    "VA VC VE VN VU WS YE ZA ZM ZW"
).split()


def flag_emoji(iso: str) -> str:
    """把两位国家代码转成国旗 emoji（与服务端 GetRegionUnicodeEmoji 同一套算法）。"""
    iso = iso.strip().upper()
    if len(iso) != 2 or not iso.isalpha():
        return ""
    return chr(0x1F1E6 + ord(iso[0]) - 65) + chr(0x1F1E6 + ord(iso[1]) - 65)


def _open(req: Request, timeout: float) -> dict:
    try:
        with urlopen(req, timeout=timeout) as resp:
            body = resp.read()
    except HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='replace')}") from e
    except URLError as e:
        raise RuntimeError(f"网络错误: {e.reason}") from e
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise RuntimeError(f"返回非 JSON: {body[:200]!r}")


def register(server: str, adkey: str, name: str, timeout: float) -> dict:
    url = f"{server}/api/clients/register?name={quote(name, safe='')}"
    req = Request(url, data=b"{}", method="POST",
                  headers={"Authorization": f"Bearer {adkey}",
                           "Content-Type": "application/json"})
    res = _open(req, timeout)
    data = res.get("data", {})
    if res.get("status") != "success" or not data.get("uuid") or not data.get("token"):
        raise RuntimeError(f"注册失败: {res}")
    return {"uuid": data["uuid"], "token": data["token"]}


def rpc(server: str, token: str, method: str, params: dict, rid: str, timeout: float) -> dict:
    url = f"{server}/api/clients/v2/rpc?token={quote(token, safe='')}"
    payload = json.dumps({"jsonrpc": JSONRPC, "method": method, "params": params, "id": rid},
                         separators=(",", ":")).encode()
    req = Request(url, data=payload, method="POST",
                  headers={"Content-Type": "application/json"})
    res = _open(req, timeout)
    if res.get("error"):
        raise RuntimeError(f"RPC 错误 ({method}): {res['error']}")
    return res


def basic_info(country: str) -> dict:
    return {
        "cpu_name": "Virtual CPU", "cpu_cores": 2, "cpu_physical_cores": 1,
        "arch": "amd64", "os": "Linux", "kernel_version": "6.1.0",
        "ipv4": BOGON_IP, "ipv6": "",           # 兜底 IP，阻止 GeoIP 覆盖 region
        "region": flag_emoji(country),          # 直接指定国旗
        "mem_total": 2 * 1024**3, "swap_total": 0, "disk_total": 40 * 1024**3,
        "gpu_name": "", "virtualization": "kvm", "version": "komari-globe/1.0",
    }


def report() -> dict:
    mt, dt = 2 * 1024**3, 40 * 1024**3
    return {
        "cpu": {"name": "Virtual CPU", "cores": 2, "arch": "amd64", "usage": round(random.uniform(3, 40), 2)},
        "ram": {"total": mt, "used": random.randint(mt // 4, mt * 3 // 4)},
        "swap": {"total": 0, "used": 0},
        "load": {"load1": round(random.uniform(0.02, 1.0), 2), "load5": round(random.uniform(0.02, 0.8), 2), "load15": round(random.uniform(0.02, 0.6), 2)},
        "disk": {"total": dt, "used": random.randint(dt // 5, dt * 3 // 5)},
        "network": {"up": random.randint(1_000, 500_000), "down": random.randint(1_000, 2_000_000),
                    "totalUp": random.randint(1_000_000, 5_000_000_000), "totalDown": random.randint(1_000_000, 5_000_000_000)},
        "connections": {"tcp": random.randint(1, 60), "udp": random.randint(0, 10)},
        "uptime": int(time.monotonic()), "process": random.randint(30, 120), "message": "",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="komari 点亮全球：批量伪装探针")
    ap.add_argument("--server", required=True, help="komari 面板地址，如 https://komari.example.com")
    ap.add_argument("--adkey", default="", help="自动发现密钥（仅 --new 注册时需要，≥12 位）")
    ap.add_argument("--new", action="store_true", help="注册一批新的假探针并保存")
    ap.add_argument("--countries", default="all", help="国家代码列表，逗号分隔；默认 all（全部 ~200 个）")
    ap.add_argument("--interval", type=float, default=20.0, help="保活上报间隔秒（面板在线 TTL=35s，默认 20）")
    ap.add_argument("--timeout", type=float, default=30.0, help="单次请求超时秒")
    ap.add_argument("--state", type=Path, default=STATE_FILE, help="探针状态文件")
    args = ap.parse_args()
    server = args.server.rstrip("/")

    if args.countries.strip().lower() == "all":
        countries = COUNTRIES
    else:
        countries = [c.strip().upper() for c in args.countries.split(",") if c.strip()]

    if args.new:
        if len(args.adkey) < 12:
            logging.error("注册需要 --adkey（自动发现密钥，≥12 位，在面板后台设置里开启）")
            return 1
        agents = []
        for i, cc in enumerate(countries, 1):
            try:
                c = register(server, args.adkey, f"globe-{cc}", args.timeout)
                c["country"] = cc
                agents.append(c)
                logging.info("[%d/%d] 注册 %s %s -> %s", i, len(countries), cc, flag_emoji(cc), c["uuid"][:8])
            except RuntimeError as e:
                logging.error("注册 %s 失败: %s", cc, e)
            time.sleep(0.15)
        if not agents:
            logging.error("一个都没注册成功，检查 server / adkey / 自动发现是否开启")
            return 1
        args.state.write_text(json.dumps({"server": server, "agents": agents}, ensure_ascii=False, indent=2), "utf-8")
        logging.info("已注册 %d 个，保存到 %s", len(agents), args.state)
    else:
        try:
            saved = json.loads(args.state.read_text("utf-8"))
        except FileNotFoundError:
            logging.error("找不到 %s，请先用 --new 注册", args.state)
            return 1
        if saved.get("server", "").rstrip("/") != server:
            logging.error("状态文件属于 %s，与 --server 不符", saved.get("server"))
            return 1
        agents = saved["agents"]

    # 先把每个探针的基础信息（含国旗）写一遍
    for a in agents:
        try:
            rpc(server, a["token"], "agent.basicInfo", {"info": basic_info(a["country"])}, "bi", args.timeout)
        except RuntimeError as e:
            logging.warning("basicInfo %s 失败: %s", a["country"], e)
    logging.info("开始保活 %d 个探针，每 %.0fs 一轮，Ctrl+C 停止", len(agents), args.interval)

    # 循环保活
    try:
        while True:
            ok = 0
            for a in agents:
                try:
                    rpc(server, a["token"], "agent.report", {"report": report()}, f"r{time.time_ns()}", args.timeout)
                    ok += 1
                except RuntimeError as e:
                    logging.debug("report %s 失败: %s", a["country"], e)
            logging.info("本轮在线 %d/%d", ok, len(agents))
            time.sleep(args.interval)
    except KeyboardInterrupt:
        logging.info("已停止（探针仍留在面板，可再次运行本脚本继续保活）")
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.exit(main())
