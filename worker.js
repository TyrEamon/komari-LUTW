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
 *   ACCESS_KEY     保护 /register /setup /reset 的口令(可选, 设了就必须带 ?key=)
 *   SELF_URL       本 worker 的公开地址(如 https://xxx.workers.dev)。设了 cron 就走
 *                  "扇出"模式: 只发几个子请求到自己的 /report 分片, 每个分片是独立调用、
 *                  各有独立的 50 子请求额度 —— 于是【免费版也能保活 200+ 个】。不设=直接保活。
 *   SHARD_SIZE     每个分片的探针数(默认 40, 免费版务必 ≤45)
 *   CRON_ROUNDS    每次触发内部轮数(默认 2)   CRON_GAP  轮间隔秒(默认 30)
 *
 * 路由:
 *   GET /register?limit=20            用 adkey 自动建号并注册(幂等), 一次最多 limit 个
 *   GET /setup?tokens=tok:US,tok2:JP  用你已有的客户端 token 接入(不需要 adkey)
 *   GET /report?offset=0&limit=40     保活一个分片(默认全部); cron/扇出会自动带 offset/limit
 *   GET /drive?shard=40               手动触发一次扇出保活(等价于 cron 干的事)
 *   GET /status                       看已注册了多少、都是哪些国家
 *   GET /reset                        清空 KV 里的记录(不会删面板上的探针)
 *
 * 自定义配置(可加在 /register 或 /setup 上, 也可用 SPEC_* 环境变量; 不填=每台随机):
 *   cpu=CPU型号  cores=核数  mem=内存GB  disk=磁盘GB  swap=交换GB
 *   arch=amd64  os=系统名  virt=虚拟化  gpu=显卡  kernel=内核  pcores=物理核
 *   ipmode=v4|v6|both  ip4=固定v4  ip6=固定v6
 *     IP 默认随机且不可被 GeoIP 定位(v4=CGNAT 100.64/10, v6=文档段 2001:db8::),
 *     这样国旗不会被 GeoIP 覆盖。ipmode=both 即双栈 v4+v6。
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
  const octet = () => Math.floor(rng() * 256), h16 = () => Math.floor(rng() * 65536).toString(16);
  // IP: 随机、且【不可被 GeoIP 定位】(否则会覆盖我们手填的国旗)。
  //   v4 用 CGNAT 段 100.64.0.0/10(看着像真机、GeoIP 判为保留地址);
  //   v6 用文档段 2001:db8::/32。二者都不会被解析出国家 => 国旗稳。
  const ip4 = ov.ip4 || `100.${64 + Math.floor(rng() * 64)}.${octet()}.${1 + Math.floor(rng() * 254)}`;
  const ip6 = ov.ip6 || `2001:db8:${h16()}:${h16()}:${h16()}::${(1 + Math.floor(rng() * 65534)).toString(16)}`;
  // ipMode: 默认 v4。设 mix/random 时按 token 稳定地混搭(≈55% 双栈, 40% 仅v4, 5% 仅v6), 更像真实机群。
  let ipMode = (ov.ipmode || "v4").toLowerCase();
  if (ipMode === "mix" || ipMode === "random") {
    const r = (hash32("ipm:" + token) % 1000) / 1000;
    ipMode = r < 0.55 ? "both" : (r < 0.95 ? "v4" : "v6");
  }
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
    ip4, ip6, ipMode,           // v4 | v6 | both (mix/random 已在上面解析成具体值)

    // 以下为"活值"基线(稳定), 让浮动看起来合理; uprate/downrate 可自定义(KB/s), 不填=随机
    upRate: ov.uprate != null ? ov.uprate : Math.floor(1e3 + rng() * 60e3),   // 平均上行
    downRate: ov.downrate != null ? ov.downrate : Math.floor(2e3 + rng() * 180e3), // 平均下行
    baseUp: Math.floor(rng() * 20) * GB,            // 累计流量基数
    baseDown: Math.floor(rng() * 40) * GB,
    memUsedFrac: 0.2 + rng() * 0.45,                // 内存基线占用比
    diskUsedFrac: 0.15 + rng() * 0.5,               // 磁盘占用比(基本不变)
    procBase: Math.floor(40 + rng() * 160),
    // 振荡参数: 按时间平滑起伏, 每台探针周期/相位都不同。
    // 网络周期最短(最灵动); CPU/内存中等周期 => 每次上报都看得见自然上下波动。
    cpuBase: 5 + rng() * 18, cpuAmp: 10 + rng() * 26,
    pA: 20 + rng() * 30, pB: 120 + rng() * 200,     // CPU 主/次周期(秒), 中等
    phCpu: rng() * 6.283, phNet: rng() * 6.283, phMem: rng() * 6.283,
    pNet: 3 + rng() * 6,                            // 网络周期(秒), 快: 3~9s
    pMem: 60 + rng() * 140,                         // 内存漂移周期, 中速(看得见)
  };
}

// 从 URL 参数 / 环境变量解析全局自定义配置(不填=随机)
function overrides(url, env) {
  const q = (k) => { const v = url.searchParams.get(k); return v == null || v === "" ? undefined : v; };
  const num = (v) => v == null ? undefined : parseInt(v, 10);
  const bytes = (v) => v == null ? undefined : Math.round(parseFloat(v) * GB); // 单位: GB
  const kbps = (v) => v == null ? undefined : Math.round(parseFloat(v) * 1024); // 单位: KB/s -> B/s
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
    uprate: kbps(q("uprate") ?? env.SPEC_UPRATE),     // 平均上行 KB/s(不填=随机)
    downrate: kbps(q("downrate") ?? env.SPEC_DOWNRATE), // 平均下行 KB/s
    ip4: q("ip4") ?? env.SPEC_IP4,                 // 固定某个 v4(不填=随机 CGNAT)
    ip6: q("ip6") ?? env.SPEC_IP6,                 // 固定某个 v6(不填=随机文档段)
    ipmode: ((q("ipmode") ?? env.SPEC_IPMODE) || "").toLowerCase() || undefined, // v4|v6|both
  };
}

function basicInfo(cc, p) {
  const mode = p.ipMode || "v4";
  return {
    cpu_name: p.cpu_name, cpu_cores: p.cpu_cores, cpu_physical_cores: p.cpu_physical_cores,
    arch: p.arch, os: p.os, kernel_version: p.kernel_version,
    ipv4: mode === "v6" ? "" : (p.ip4 || BOGON_IP),
    ipv6: mode === "v4" ? "" : (p.ip6 || ""),
    region: flagEmoji(cc),
    mem_total: p.mem_total, swap_total: p.swap_total, disk_total: p.disk_total,
    gpu_name: p.gpu_name, virtualization: p.virtualization, version: "komari-globe/1.0",
  };
}

// 活值: 按时间起伏。网络最灵动(短周期+大噪声+突发); CPU/内存/负载中速自然波动(每次上报都看得见)。
function reportPayload(p, boot) {
  const t = Date.now() / 1000;
  const uptime = Math.max(60, Math.floor(t - (boot || t)));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const noise = (a) => (Math.random() - 0.5) * a;
  // CPU: 中速双正弦 + 噪声, 偶发尖峰
  let usage = p.cpuBase + p.cpuAmp * 0.6 * Math.sin(t / p.pA + p.phCpu)
    + p.cpuAmp * 0.4 * Math.sin(t / p.pB + p.phCpu * 1.7) + noise(3.5);
  if (Math.random() < 0.02) usage += 18 + Math.random() * 50;    // 偶发尖峰
  usage = +clamp(usage, 0.3, 99).toFixed(2);
  // 内存: 中速漂移(看得见); 磁盘: 几乎不动(真机磁盘本就不怎么变)
  const memFrac = clamp(p.memUsedFrac + 0.09 * Math.sin(t / p.pMem + p.phMem) + noise(0.012), 0.05, 0.95);
  const diskFrac = clamp(p.diskUsedFrac + noise(0.0015), 0.02, 0.98);
  // 网络实时: 短周期波 + 大噪声 + 频繁突发 => 每次采样都明显不同, 看着"活"
  const fast = 0.5 + 0.5 * Math.sin(t / p.pNet + p.phNet);
  let up = p.upRate * (0.3 + 1.1 * fast) + noise(p.upRate * 1.3);
  let down = p.downRate * (0.3 + 1.1 * fast) + noise(p.downRate * 1.3);
  if (Math.random() < 0.12) { up *= 1.5 + Math.random() * 4; down *= 1.5 + Math.random() * 5; }
  const load1 = +clamp(usage / 100 * p.cpu_cores * (0.85 + Math.random() * 0.3), 0, p.cpu_cores * 2.5).toFixed(2);
  return {
    cpu: { name: p.cpu_name, cores: p.cpu_cores, arch: p.arch, usage },
    ram: { total: p.mem_total, used: Math.floor(p.mem_total * memFrac) },
    swap: { total: p.swap_total, used: p.swap_total ? Math.floor(p.swap_total * clamp(0.1 + 0.2 * Math.sin(t / p.pMem), 0, 0.6)) : 0 },
    load: { load1, load5: +(load1 * (0.8 + Math.random() * 0.1)).toFixed(2), load15: +(load1 * (0.6 + Math.random() * 0.1)).toFixed(2) },
    disk: { total: p.disk_total, used: Math.floor(p.disk_total * diskFrac) },
    network: {
      up: Math.max(0, Math.floor(up)), down: Math.max(0, Math.floor(down)),
      totalUp: p.baseUp + Math.floor(uptime * p.upRate * 0.6),
      totalDown: p.baseDown + Math.floor(uptime * p.downRate * 0.6),
    },
    connections: { tcp: Math.floor(8 + fast * 60 + Math.random() * 25), udp: Math.floor(Math.random() * 15) },
    uptime, process: Math.floor(p.procBase + 12 * Math.sin(t / p.pB + p.phMem) + noise(4)), message: "",
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
  const spread = Math.max(0, opts.spread || 0) * 1000;   // 错开窗口(秒): 让 N 个探针不在同一刻上报
  let ok = 0, fail = 0;
  for (let i = 0; i < rounds; i++) {
    const start = Date.now();
    const results = await Promise.allSettled(agents.map(async (a) => {
      if (spread) {
        // 每个探针有稳定的相位(按 token 派生)+ 少量随机抖动 => 像各自独立的定时器, 时间戳散开
        const phase = (hash32(a.token) % 10000) / 10000;
        await sleep(phase * spread + Math.random() * spread * 0.2);
      }
      return komariRpc(c.server, a.token, "agent.report",
        { report: reportPayload({ ...buildProfile(a.token), ...(a.p || {}) }, a.boot) }, `r${Date.now()}`);
    }));
    ok = results.filter((r) => r.status === "fulfilled").length;
    fail = results.length - ok;
    if (i < rounds - 1) await sleep(Math.max(0, gap - (Date.now() - start)));
  }
  return { online: ok, failed: fail, count: agents.length, rounds };
}

const txt = (s, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const html = (s) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });

// 内联单页控制台(纯 HTML+JS, 无框架/无构建)。浏览器打开 worker 首页即可可视化操作。
const UI = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>komari 点亮全球</title>
<style>
:root{--bg:#0f1220;--card:#1a1f36;--line:#2a3152;--fg:#e8ebf5;--mut:#8b93b8;--acc:#6c8cff;--ok:#37d67a;--err:#ff6b6b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,"Segoe UI",sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:20px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 16px;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
.card h2{font-size:14px;margin:0 0 12px;color:var(--acc)}
label{display:block;font-size:12px;color:var(--mut);margin:8px 0 2px}
input,select{width:100%;padding:8px 10px;background:#0d1024;border:1px solid var(--line);border-radius:8px;color:var(--fg);font-size:13px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.chk{display:flex;align-items:center;gap:6px;margin-top:10px}.chk input{width:auto}
button{cursor:pointer;border:0;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;color:#fff;background:var(--acc);margin:10px 6px 0 0}
button.g{background:#2a3152}button.r{background:var(--err)}button:active{transform:translateY(1px)}
pre{background:#0a0c1a;border:1px solid var(--line);border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-all;min-height:40px;margin:14px 0 0;font-size:12px}
.pill{display:inline-block;background:#0d1024;border:1px solid var(--line);border-radius:20px;padding:3px 10px;margin:2px;font-size:12px}
small{color:var(--mut)}a{color:var(--acc)}
</style></head><body><div class="wrap">
<h1>komari 点亮全球 <small id="cnt"></small></h1>
<p class="sub">可视化控制台 · 数据全部本地拼接调用本 worker 接口</p>

<div class="card"><h2>访问口令</h2>
<label>ACCESS_KEY（若后台设了才需要，浏览器本地保存）</label>
<input id="key" placeholder="没设就留空" autocomplete="off">
</div>

<div class="card"><h2>① 注册探针</h2>
<label>国家代码（逗号分隔；留空=内置 ~200 个；同一国家写多次+勾选重复即可多开）</label>
<input id="countries" placeholder="US,JP,DE,GB,FR,AQ">
<div class="row3">
<div><label>IP 模式</label><select id="ipmode"><option value="">默认(v4)</option><option>v4</option><option>v6</option><option>both</option><option>mix</option></select></div>
<div><label>每次数量 limit</label><input id="limit" placeholder="20"></div>
<div><label>核数 cores</label><input id="cores" placeholder="随机"></div>
</div>
<div class="row3">
<div><label>内存 GB</label><input id="mem" placeholder="随机"></div>
<div><label>磁盘 GB</label><input id="disk" placeholder="随机"></div>
<div><label>CPU 型号</label><input id="cpu" placeholder="随机"></div>
</div>
<div class="row">
<div><label>下行 KB/s downrate</label><input id="downrate" placeholder="随机(不填=KB级)"></div>
<div><label>上行 KB/s uprate</label><input id="uprate" placeholder="随机"></div>
</div>
<label class="chk"><input type="checkbox" id="force"> 允许重复国家 / 覆盖重建 (force)</label>
<button onclick="reg()">注册 / 继续注册</button>
</div>

<div class="card"><h2>② 或用已有 token 接入</h2>
<label>tokens（格式 token:US,token2:JP）</label>
<input id="tokens" placeholder="Pf8xxxx:US,abcd:JP">
<button onclick="setup()">接入</button>
</div>

<div class="card"><h2>③ 运维</h2>
<button class="g" onclick="go('/status')">查看状态</button>
<button class="g" onclick="go('/drive?rounds=1&gap=0')">立即保活一次</button>
<label style="margin-top:12px">按国家移除（从 KV，面板仍需手动删）</label>
<input id="rmc" placeholder="US,JP">
<button class="r" onclick="rm()">移除这些国家</button>
<button class="r" onclick="if(confirm('清空 KV 全部记录?'))go('/reset')">清空全部</button>
</div>

<pre id="out">就绪。</pre>
<p class="sub">开源: <a href="https://github.com/TyrEamon/komari-LUTW" target="_blank">TyrEamon/komari-LUTW</a></p>
</div><script>
const $=id=>document.getElementById(id);
$('key').value=localStorage.getItem('k')||'';
$('key').oninput=e=>localStorage.setItem('k',e.target.value);
const out=$('out');
function qs(o){const p=[];for(const k in o){const v=o[k];if(v!==''&&v!=null)p.push(k+'='+encodeURIComponent(v))}const kk=$('key').value.trim();if(kk)p.push('key='+encodeURIComponent(kk));return p.length?'?'+p.join('&'):''}
async function call(path){out.textContent='请求中…';try{const r=await fetch(path);const t=await r.text();out.textContent=t;refresh()}catch(e){out.textContent='出错: '+e}}
function go(p){const kk=$('key').value.trim();call(p+(p.includes('?')?'&':'?')+(kk?'key='+encodeURIComponent(kk):''))}
function reg(){call('/register'+qs({countries:$('countries').value.trim(),ipmode:$('ipmode').value,limit:$('limit').value.trim(),cores:$('cores').value.trim(),mem:$('mem').value.trim(),disk:$('disk').value.trim(),cpu:$('cpu').value.trim(),downrate:$('downrate').value.trim(),uprate:$('uprate').value.trim(),force:$('force').checked?'1':''}))}
function setup(){call('/setup'+qs({tokens:$('tokens').value.trim()}))}
function rm(){const c=$('rmc').value.trim();if(!c)return;call('/remove'+qs({countries:c}))}
async function refresh(){try{const r=await fetch('/status');const t=await r.text();const m=t.match(/\\d+/);$('cnt').textContent=m?'· 已注册 '+m[0]+' 个':''}catch(e){}}
refresh();
</script></body></html>`;


// 自调度扇出: dispatcher 只发几个"子请求"到自己的 /report(每个分片 ≤ shardSize 个探针)。
// 每个子请求是一次【独立的 Worker 调用】,各自享有独立的 50 子请求额度,
// 于是免费版(单次 50 子请求上限)也能靠多个分片凑够 200+ 个探针。
async function dispatch(env, selfUrl, opts) {
  const n = (await loadAgents(env)).length;
  if (!n) return { shards: 0, total: 0, ok: 0, sample: "无探针" };
  const size = Math.max(1, opts.shardSize), rounds = Math.max(1, opts.rounds), gap = Math.max(0, opts.gap) * 1000;
  const offsets = [];
  for (let o = 0; o < n; o += size) offsets.push(o);
  const key = env.ACCESS_KEY ? `&key=${encodeURIComponent(env.ACCESS_KEY)}` : "";
  // 优先用 Service Binding(SELF, 绑定到本 worker) —— workers.dev 自请求会被 CF 404,
  // 服务绑定则在内部直接再起一个实例, 不走公网、不会 404。没绑定才退回全局 fetch。
  const base = (selfUrl || "https://self.local").replace(/\/+$/, "");
  const call = (path) => env.SELF ? env.SELF.fetch(new Request(base + path)) : fetch(base + path);
  let ok = 0, sample = "";
  for (let i = 0; i < rounds; i++) {
    const start = Date.now();
    // spread=gap: 让每个分片把这批探针的上报错开到整个间隔内, 时间戳不再整齐划一
    const res = await Promise.allSettled(offsets.map((o) =>
      call(`/report?offset=${o}&limit=${size}&rounds=1&spread=${opts.gap}${key}`)));
    if (i === 0) { // 首轮记录诊断
      for (const r of res) {
        if (r.status === "fulfilled") {
          if (r.value.ok) { ok++; if (!sample) sample = (await r.value.text()).slice(0, 70); }
          else if (!sample) sample = "HTTP " + r.value.status;
        } else if (!sample) sample = "fetch失败: " + String(r.reason).slice(0, 90);
      }
    }
    if (i < rounds - 1) await sleep(Math.max(0, gap - (Date.now() - start)));
  }
  return { shards: offsets.length, total: n, ok, sample, via: env.SELF ? "binding" : "fetch" };
}

async function handle(request, env, ctx) {

  const url = new URL(request.url);
  const c = cfg(url, env);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const gated = (p) => c.accessKey && url.searchParams.get("key") !== c.accessKey && ["/register", "/setup", "/remove", "/reset"].includes(p);

  if (!env.KOMARI_KV) return txt("❌ 未绑定 KV 命名空间 KOMARI_KV, 见部署说明", 500);
  // 首页返回可视化控制台(GET / 且非 report 调用)
  if (path === "/" && request.method === "GET") return html(UI);
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

    if (path === "/report") {
      if (!c.server) return txt("❌ 缺少 server(URL 参数或 KOMARI_SERVER)", 400);
      const r = await keepAlive(env, c, {
        offset: parseInt(url.searchParams.get("offset") || "0", 10),
        limit: parseInt(url.searchParams.get("limit") || "0", 10),
        rounds: parseInt(url.searchParams.get("rounds") || "1", 10),
        gap: parseInt(url.searchParams.get("gap") || "30", 10),
        spread: parseInt(url.searchParams.get("spread") || "0", 10),
      });
      return txt(`✅ 保活完成 在线 ${r.online}/${r.count}（${r.rounds} 轮）` + (r.failed ? ` 失败 ${r.failed}` : ""));
    }

    if (path === "/drive") {
      // 扇出保活: 手动触发一次(等价于 cron 做的事), selfUrl 取当前访问地址
      const selfUrl = (env.SELF_URL || url.origin).replace(/\/+$/, "");
      const r = await dispatch(env, selfUrl, {
        shardSize: parseInt(url.searchParams.get("shard") || env.SHARD_SIZE || "40", 10),
        rounds: parseInt(url.searchParams.get("rounds") || env.CRON_ROUNDS || "2", 10),
        gap: parseInt(url.searchParams.get("gap") || env.CRON_GAP || "30", 10),
      });
      return txt(`✅ 扇出完成: ${r.shards} 个分片覆盖 ${r.total} 个探针\n方式: ${r.via} | 首轮成功分片: ${r.ok}/${r.shards}\n分片返回: ${r.sample}`);
    }

    if (path === "/status") {
      const agents = await loadAgents(env);
      return txt(`已注册 ${agents.length} 个探针:\n` + agents.map((a) => a.country + flagEmoji(a.country)).join(" "));
    }

    if (path === "/remove") {
      const cc = url.searchParams.get("countries");
      const tk = url.searchParams.get("tokens");
      if (!cc && !tk) return txt("❌ 用法: /remove?countries=US,JP  或  /remove?tokens=xxx,yyy", 400);
      const ccSet = new Set((cc ? cc.split(",") : []).map((x) => x.trim().toUpperCase()).filter(Boolean));
      const tkSet = new Set((tk ? tk.split(",") : []).map((x) => x.trim()).filter(Boolean));
      const agents = await loadAgents(env);
      const kept = agents.filter((a) => !ccSet.has(a.country) && !tkSet.has(a.token));
      const removed = agents.length - kept.length;
      await saveAgents(env, kept);
      return txt(`✅ 从 KV 移除 ${removed} 个, 剩余 ${kept.length} 个\n(面板上对应探针仍需在后台手动删)`);
    }

    if (path === "/reset") {
      await env.KOMARI_KV.delete(KV_KEY);
      return txt("✅ 已清空 KV 记录（面板上的探针不受影响，需在后台手动删）");
    }

    return txt("komari 点亮全球\n路由: /register  /setup?tokens=tok:US  /report  /drive  /status  /remove?countries=US,JP  /reset\n先设 KOMARI_SERVER, 注册好探针, 再让 cron 定时打");
  } catch (e) {
    return txt(`❌ 出错: ${e.message}`, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
  // Cloudflare Cron Trigger(每分钟触发)。
  // 设了 SELF_URL 就走"扇出"(免费版也能带 200+); 没设则直接保活(探针少或付费版够用)。
  async scheduled(event, env, ctx) {
    if (!env.KOMARI_KV || !env.KOMARI_SERVER) return;
    const selfUrl = (env.SELF_URL || "").replace(/\/+$/, "");
    const rounds = parseInt(env.CRON_ROUNDS || "2", 10), gap = parseInt(env.CRON_GAP || "30", 10);
    if (env.SELF || selfUrl) {
      ctx.waitUntil(dispatch(env, selfUrl, { shardSize: parseInt(env.SHARD_SIZE || "40", 10), rounds, gap }));
    } else {
      const c = { server: env.KOMARI_SERVER.replace(/\/+$/, "") };
      ctx.waitUntil(keepAlive(env, c, { offset: 0, limit: 0, rounds, gap, spread: gap }));
    }
  },

};


