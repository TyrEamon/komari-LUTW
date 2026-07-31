/**
 * komari 点亮全球 —— Cloudflare Worker / Pages 版
 * ==================================================
 * 直接用 komari 的 HTTP JSON-RPC 协议注册假探针并保活，不需要 protobuf 中转。
 *
 * 需要绑定一个 KV 命名空间: KOMARI_KV （用来保存已注册探针的 uuid/token）。
 *
 * 环境变量(可选，也可用 URL 参数覆盖):
 *   KOMARI_SERVER  面板地址, 如 https://komari.example.com
 *   KOMARI_ADKEY   自动发现密钥(注册时用, ≥12 位)
 *   ACCESS_KEY     保护 /register /reset 的口令(可选, 设了就必须带 ?key=)
 *
 * 路由:
 *   GET /register?limit=20            用 adkey 自动建号并注册(幂等), 一次最多 limit 个
 *   GET /setup?tokens=tok:US,tok2:JP  用你已有的客户端 token 接入(不需要 adkey)
 *   GET /report?rounds=2&gap=30       保活: 给已注册探针发 report(默认全部)
 *   GET /status                       看已注册了多少、都是哪些国家
 *   GET /reset                        清空 KV 里的记录(不会删面板上的探针)
 *
 * 自定义配置(可加在 /register 或 /setup 上, 也可用 SPEC_* 环境变量; 不填=每台随机):
 *   cpu=CPU型号  cores=核数  mem=内存GB  disk=磁盘GB  swap=交换GB
 *   arch=amd64  os=系统名  virt=虚拟化  gpu=显卡  kernel=内核  pcores=物理核
 *   例: /register?cpu=AMD%20EPYC%209654&cores=4&mem=8&disk=160
 *   注: 不自定义时每个探针按 token 生成一套【稳定】的真实感配置(CPU型号/内存/磁盘固定,
 *       只有使用率/负载/流量浮动, 累计流量随运行时间增长)。这些数字是编造的, 不是真实机器。
 *
 * 关键点: ipv4 填 192.0.2.1(保留地址, GeoIP 无法定位) + 直接塞 region 国旗,
 *          所以不用关面板 GeoIP, 也不影响你真实的服务器。
 */

const BOGON_IP = "192.0.2.1";
const GB = 1024 ** 3, MB = 1024 ** 2;


// ISO 3166-1 alpha-2, ~200 个国家/地区(含南极洲 AQ)
const COUNTRIES = (
  "AD AE AF AG AL AM AO AR AT AU AW AZ AQ BA BB BD BE BF BG BH BI BJ BN BO " +
  "BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK " +
  "DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GL GM GN GQ GR GT " +
  "GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN " +
  "KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM " +
  "MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH " +
  "PK PL PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO " +
  "SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ " +
  "VA VC VE VN VU WS YE ZA ZM ZW"
).split(" ");

function flagEmoji(cc) {
  cc = (cc || "").trim().toUpperCase();
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(0x1f1e6 + cc.charCodeAt(0) - 65,
                              0x1f1e6 + cc.charCodeAt(1) - 65);
}

function cfg(url, env) {
  return {
    server: (url.searchParams.get("server") || env.KOMARI_SERVER || "").replace(/\/+$/, ""),
    adkey: url.searchParams.get("adkey") || env.KOMARI_ADKEY || "",
    accessKey: env.ACCESS_KEY || "",
  };
}

// ---- komari 协议 ----
async function komariRegister(server, adkey, name) {
  const r = await fetch(`${server}/api/clients/register?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${adkey}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const j = await r.json().catch(() => ({}));
  if (j.status !== "success" || !j.data || !j.data.uuid || !j.data.token) {
    throw new Error(`注册失败 HTTP ${r.status}: ${JSON.stringify(j)}`);
  }
  return { uuid: j.data.uuid, token: j.data.token };
}

async function komariRpc(server, token, method, params, id) {
  const r = await fetch(`${server}/api/clients/v2/rpc?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(`RPC ${method} 错误: ${JSON.stringify(j.error)}`);
  return j;
}

// ---- 硬件画像(让假探针看起来像台真机器) ----
// 每个探针的静态配置由 token 派生的伪随机数决定 => 同一探针每次显示的
// CPU/内存/磁盘都一样(像真机),只有使用率/负载/流量这些"活"的值才浮动。
const CPUS = [
  ["Intel(R) Xeon(R) Platinum 8175M CPU @ 2.50GHz", "amd64"],
  ["Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz", "amd64"],
  ["Intel(R) Xeon(R) E5-2686 v4 @ 2.30GHz", "amd64"],
  ["Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz", "amd64"],
  ["AMD EPYC 7B13", "amd64"], ["AMD EPYC 7402P 24-Core Processor", "amd64"],
  ["AMD Ryzen 9 5900X 12-Core Processor", "amd64"],
  ["Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz", "amd64"],
  ["Ampere(R) Altra(R) Q80-30", "arm64"], ["Neoverse-N1", "arm64"],
];
const OSES = ["Ubuntu 24.04.4 LTS", "Ubuntu 22.04.4 LTS", "Debian GNU/Linux 12 (bookworm)",
  "Debian GNU/Linux 11 (bullseye)", "CentOS Stream 9", "Rocky Linux 9.3 (Blue Onyx)",
  "AlmaLinux 9.4 (Seafoam Ocelot)", "Fedora Linux 40 (Server Edition)", "Alpine Linux v3.20"];
const KERNELS = ["6.8.0-40-generic", "5.15.0-113-generic", "6.1.0-21-amd64",
  "5.10.0-30-amd64", "5.14.0-427.el9.x86_64", "6.6.32-0-lts"];
const VIRTS = ["kvm", "kvm", "kvm", "openvz", "lxc", "vmware", "xen", "amazon", "microsoft"];
const MEMS = [512 * MB, 1 * GB, 2 * GB, 2 * GB, 4 * GB, 4 * GB, 8 * GB, 16 * GB, 32 * GB];
const DISKS = [10 * GB, 20 * GB, 20 * GB, 25 * GB, 40 * GB, 50 * GB, 80 * GB, 100 * GB, 160 * GB, 200 * GB];
const CORESET = [1, 1, 2, 2, 2, 4, 4, 8];

function hash32(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ov: 用户自定义(全局), 未指定的字段用 token 派生的随机值
function buildProfile(token, ov = {}) {
  const rng = mulberry32(hash32("globe:" + token));
  const cp = pick(rng, CPUS);
  const cores = ov.cores || pick(rng, CORESET);
  return {
    cpu_name: ov.cpu || cp[0],
    arch: ov.arch || cp[1],
    cpu_cores: cores,
    cpu_physical_cores: ov.pcores || Math.max(1, rng() < 0.5 ? cores : Math.ceil(cores / 2)),
    os: ov.os || pick(rng, OSES),
    kernel_version: ov.kernel || pick(rng, KERNELS),
    virtualization: ov.virt || pick(rng, VIRTS),
    gpu_name: ov.gpu != null ? ov.gpu : (rng() < 0.15 ? "Intel Corporation 82371AB/EB/MB PIIX4 ACPI" : ""),
    mem_total: ov.mem != null ? ov.mem : pick(rng, MEMS),
    swap_total: ov.swap != null ? ov.swap : pick(rng, [0, 0, 0, 512 * MB, 1 * GB, 2 * GB]),
    disk_total: ov.disk != null ? ov.disk : pick(rng, DISKS),
    // 以下为"活值"基线(稳定), 让浮动看起来合理
    upRate: Math.floor(1e3 + rng() * 60e3),        // 平均上行 ~1-60 KB/s
    downRate: Math.floor(2e3 + rng() * 180e3),      // 平均下行 ~2-180 KB/s
    baseUp: Math.floor(rng() * 20) * GB,            // 累计流量基数
    baseDown: Math.floor(rng() * 40) * GB,
    memUsedFrac: 0.2 + rng() * 0.45,                // 内存基线占用比
    diskUsedFrac: 0.15 + rng() * 0.5,               // 磁盘占用比(基本不变)
    procBase: Math.floor(40 + rng() * 160),
  };
}

// 从 URL 参数 / 环境变量解析全局自定义配置(不填=随机)
function overrides(url, env) {
  const q = (k) => { const v = url.searchParams.get(k); return v == null || v === "" ? undefined : v; };
  const num = (v) => v == null ? undefined : parseInt(v, 10);
  const bytes = (v) => v == null ? undefined : Math.round(parseFloat(v) * GB); // 单位: GB
  return {
    cpu: q("cpu") ?? env.SPEC_CPU,
    cores: num(q("cores") ?? env.SPEC_CORES),
    pcores: num(q("pcores") ?? env.SPEC_PCORES),
    arch: q("arch") ?? env.SPEC_ARCH,
    os: q("os") ?? env.SPEC_OS,
    kernel: q("kernel") ?? env.SPEC_KERNEL,
    gpu: q("gpu") ?? env.SPEC_GPU,
    virt: q("virt") ?? env.SPEC_VIRT,
    mem: bytes(q("mem") ?? env.SPEC_MEM),
    swap: bytes(q("swap") ?? env.SPEC_SWAP),
    disk: bytes(q("disk") ?? env.SPEC_DISK),
  };
}

function basicInfo(cc, p) {
  return {
    cpu_name: p.cpu_name, cpu_cores: p.cpu_cores, cpu_physical_cores: p.cpu_physical_cores,
    arch: p.arch, os: p.os, kernel_version: p.kernel_version,
    ipv4: BOGON_IP, ipv6: "", region: flagEmoji(cc),
    mem_total: p.mem_total, swap_total: p.swap_total, disk_total: p.disk_total,
    gpu_name: p.gpu_name, virtualization: p.virtualization, version: "komari-globe/1.0",
  };
}

// 活值: 每次上报浮动, 但基于该探针稳定的画像; 累计流量随运行时间增长
function reportPayload(p, boot) {
  const now = Math.floor(Date.now() / 1000);
  const uptime = Math.max(60, now - (boot || now));
  const jit = (base, f) => Math.max(0, Math.floor(base * (1 + (Math.random() - 0.5) * f)));
  const usage = +Math.min(98, 2 + Math.random() * 22 + (Math.random() < 0.05 ? Math.random() * 55 : 0)).toFixed(2);
  const load1 = +(usage / 100 * p.cpu_cores * (0.7 + Math.random() * 0.8)).toFixed(2);
  return {
    cpu: { name: p.cpu_name, cores: p.cpu_cores, arch: p.arch, usage },
    ram: { total: p.mem_total, used: Math.floor(Math.min(p.mem_total * 0.95, p.mem_total * p.memUsedFrac * (1 + (Math.random() - 0.5) * 0.3))) },
    swap: { total: p.swap_total, used: p.swap_total ? Math.floor(p.swap_total * Math.random() * 0.4) : 0 },
    load: { load1, load5: +(load1 * (0.7 + Math.random() * 0.2)).toFixed(2), load15: +(load1 * (0.5 + Math.random() * 0.2)).toFixed(2) },
    disk: { total: p.disk_total, used: Math.floor(p.disk_total * p.diskUsedFrac * (1 + (Math.random() - 0.5) * 0.02)) },
    network: {
      up: jit(p.upRate, 1.6), down: jit(p.downRate, 1.6),
      totalUp: p.baseUp + Math.floor(uptime * p.upRate * 0.6),
      totalDown: p.baseDown + Math.floor(uptime * p.downRate * 0.6),
    },
    connections: { tcp: Math.floor(8 + Math.random() * 80), udp: Math.floor(Math.random() * 15) },
    uptime, process: p.procBase + Math.floor((Math.random() - 0.5) * 10), message: "",
  };
}


// ---- KV 状态 ----
const KV_KEY = "agents";
async function loadAgents(env) { return (await env.KOMARI_KV.get(KV_KEY, "json")) || []; }
async function saveAgents(env, a) { await env.KOMARI_KV.put(KV_KEY, JSON.stringify(a)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 业务 ----
async function doRegister(env, c, opts) {
  if (c.adkey.length < 12) throw new Error("缺少有效 adkey(自动发现密钥, ≥12 位)");
  const want = opts.countries || COUNTRIES;
  const agents = await loadAgents(env);
  const have = new Set(agents.map((a) => a.country));
  const todo = want.filter((cc) => opts.force || !have.has(cc)).slice(0, opts.limit);
  const added = [], failed = [];
  for (const cc of todo) {
    try {
      const { uuid, token } = await komariRegister(c.server, c.adkey, `globe-${cc}`);
      const p = buildProfile(token, opts.ov);
      await komariRpc(c.server, token, "agent.basicInfo", { info: basicInfo(cc, p) }, "bi");
      agents.push({ country: cc, uuid, token, boot: Math.floor(Date.now() / 1000), p });
      added.push(cc);
    } catch (e) {
      failed.push(`${cc}: ${e.message}`);
    }
  }
  await saveAgents(env, agents);
  const remaining = want.filter((cc) => !new Set(agents.map((a) => a.country)).has(cc)).length;
  return { added, failed, total: agents.length, remaining };
}

// 手动模式: 直接用你从 komari 拿到的客户端 token(install 命令里 -t 后面那串)。
// 格式: tokens=token1:US,token2:JP,...  不需要 adkey / 不用管理员权限。
async function doSetup(env, c, pairs, opts = {}) {
  const agents = await loadAgents(env);
  const byTok = new Map(agents.map((a) => [a.token, a]));
  const added = [], failed = [];
  for (const { token, country } of pairs) {
    try {
      const p = buildProfile(token, opts.ov);
      await komariRpc(c.server, token, "agent.basicInfo", { info: basicInfo(country, p) }, "bi");
      const a = { country, token, boot: Math.floor(Date.now() / 1000), p };
      byTok.set(token, a);
      added.push(country);
    } catch (e) {
      failed.push(`${country}: ${e.message}`);
    }
  }
  await saveAgents(env, [...byTok.values()]);
  return { added, failed, total: byTok.size };
}

async function keepAlive(env, c, opts) {

  let agents = await loadAgents(env);
  if (opts.offset || opts.limit) agents = agents.slice(opts.offset, opts.limit ? opts.offset + opts.limit : undefined);
  const rounds = Math.max(1, opts.rounds), gap = Math.max(0, opts.gap) * 1000;
  let ok = 0, fail = 0;
  for (let i = 0; i < rounds; i++) {
    const results = await Promise.allSettled(
      agents.map((a) => komariRpc(c.server, a.token, "agent.report",
        { report: reportPayload(a.p || buildProfile(a.token), a.boot) }, `r${Date.now()}`))
    );
    ok = results.filter((r) => r.status === "fulfilled").length;
    fail = results.length - ok;
    if (i < rounds - 1) await sleep(gap);
  }
  return { online: ok, failed: fail, count: agents.length, rounds };
}

const txt = (s, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const c = cfg(url, env);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const gated = (p) => c.accessKey && url.searchParams.get("key") !== c.accessKey && ["/register", "/setup", "/reset"].includes(p);

  if (!env.KOMARI_KV) return txt("❌ 未绑定 KV 命名空间 KOMARI_KV, 见部署说明", 500);
  if (gated(path)) return txt("❌ 需要正确的 ?key=", 403);

  try {
    if (path === "/register") {
      if (!c.server) return txt("❌ 缺少 server(URL 参数或 KOMARI_SERVER)", 400);
      const only = url.searchParams.get("countries");
      const r = await doRegister(env, c, {
        limit: parseInt(url.searchParams.get("limit") || "20", 10),
        force: url.searchParams.get("force") === "1",
        countries: only ? only.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : null,
        ov: overrides(url, env),
      });
      return txt(`✅ 本次注册 ${r.added.length} 个: ${r.added.map((cc) => cc + flagEmoji(cc)).join(" ")}\n` +
        `已注册合计: ${r.total} | 还差: ${r.remaining}` + (r.remaining ? `（再调一次 /register 继续）` : "（全部完成）") +
        (r.failed.length ? `\n失败 ${r.failed.length}:\n` + r.failed.join("\n") : ""));
    }

    if (path === "/setup") {
      if (!c.server) return txt("❌ 缺少 server(URL 参数或 KOMARI_SERVER)", 400);
      const raw = url.searchParams.get("tokens") || "";
      const pairs = raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
        const i = s.lastIndexOf(":");
        return i > 0 ? { token: s.slice(0, i), country: s.slice(i + 1).toUpperCase() } : null;
      }).filter(Boolean);
      if (!pairs.length) return txt("❌ 用法: /setup?tokens=你的token:US,另一个token:JP", 400);
      const r = await doSetup(env, c, pairs, { ov: overrides(url, env) });
      return txt(`✅ 已接入 ${r.added.length} 个: ${r.added.map((cc) => cc + flagEmoji(cc)).join(" ")}\n` +
        `KV 内合计: ${r.total}` + (r.failed.length ? `\n失败:\n` + r.failed.join("\n") : ""));
    }

    if (path === "/report" || path === "/") {
      if (!c.server) return txt("❌ 缺少 server(URL 参数或 KOMARI_SERVER)", 400);
      const r = await keepAlive(env, c, {
        offset: parseInt(url.searchParams.get("offset") || "0", 10),
        limit: parseInt(url.searchParams.get("limit") || "0", 10),
        rounds: parseInt(url.searchParams.get("rounds") || "1", 10),
        gap: parseInt(url.searchParams.get("gap") || "30", 10),
      });
      return txt(`✅ 保活完成 在线 ${r.online}/${r.count}（${r.rounds} 轮）` + (r.failed ? ` 失败 ${r.failed}` : ""));
    }

    if (path === "/status") {
      const agents = await loadAgents(env);
      return txt(`已注册 ${agents.length} 个探针:\n` + agents.map((a) => a.country + flagEmoji(a.country)).join(" "));
    }

    if (path === "/reset") {
      await env.KOMARI_KV.delete(KV_KEY);
      return txt("✅ 已清空 KV 记录（面板上的探针不受影响，需在后台手动删）");
    }

    return txt("komari 点亮全球\n路由: /register(用adkey自动建号)  /setup?tokens=tok:US,...(用已有token)  /report  /status  /reset\n先设 KOMARI_SERVER, 二选一注册好探针, 再让 cron 定时打 /report");
  } catch (e) {
    return txt(`❌ 出错: ${e.message}`, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
  // Cloudflare Cron Trigger(仅 Workers 支持): 每分钟触发, 内部跑 2 轮间隔 30s 覆盖整分钟
  async scheduled(event, env, ctx) {
    const c = { server: (env.KOMARI_SERVER || "").replace(/\/+$/, ""), adkey: env.KOMARI_ADKEY || "" };
    if (!env.KOMARI_KV || !c.server) return;
    ctx.waitUntil(keepAlive(env, c, {
      offset: 0, limit: 0,
      rounds: parseInt(env.CRON_ROUNDS || "2", 10),
      gap: parseInt(env.CRON_GAP || "30", 10),
    }));
  },
};


