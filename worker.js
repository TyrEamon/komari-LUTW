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
 *   GET /reprofile?offset=0&limit=40 重建已有探针画像并推送 basicInfo
 *   GET /report?offset=0&limit=40     保活一个分片(默认全部); cron/扇出会自动带 offset/limit
 *   GET /drive?shard=40               手动触发一次扇出保活(等价于 cron 干的事)
 *   GET /status                       看已注册了多少、都是哪些国家
 *   GET /reset                        清空 KV 里的记录(不会删面板上的探针)
 *
 * 自定义配置(可加在 /register 或 /setup 上, 也可用 SPEC_* 环境变量; 不填=每台随机):
 *   group=模板组  cpu=CPU型号  cores=核数  mem=内存GB  disk=磁盘GB  swap=交换GB
 *   arch=amd64  os=系统名  virt=虚拟化  gpu=显卡  kernel=内核  pcores=物理核
 *   ipmode=v4|v6|both  ip4=固定v4  ip6=固定v6
 *     IP 默认随机且不可被 GeoIP 定位(v4=CGNAT 100.64/10, v6=文档段 2001:db8::),
 *     这样国旗不会被 GeoIP 覆盖。ipmode=both 即双栈 v4+v6。
 *   模板组: budget-x86 / modern-intel / modern-amd / aws-x86 / aws-arm /
 *           gcp-x86 / gcp-arm / azure-x86 / azure-arm / oci-arm /
 *           enterprise-vmware / dedicated-x86
 *   例: /register?group=aws-arm  或 /register?cpu=AMD%20EPYC%209654&cores=4&mem=8&disk=160
 *   注: 不自定义时每个探针按 token 生成一套【稳定】的真实感配置(CPU型号/内存/磁盘固定,
 *       只有使用率/负载/流量浮动, 累计流量随运行时间增长)。这些数字是编造的, 不是真实机器。
 *
 * 关键点: ip 默认随机且不可被 GeoIP 定位(v4=CGNAT 100.64/10, v6=文档段 2001:db8::),
 *          再直接塞 region 国旗, 所以不用关面板 GeoIP, 也不影响你真实的服务器。
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

// ---- 硬件画像(按“整机模板组”生成，避免 CPU / 架构 / 系统 / 内核乱搭) ----
// 每个探针先按 token 稳定选择一个机器组，再只在组内选择 CPU、系统、内核、
// 虚拟化与规格套餐。同一个 token 每次都会得到同一套静态配置。
function hash32(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const size = (cores, pcores, memGB, diskGB, swapGB = 0) => ({
  cores, pcores, mem: memGB * GB, disk: diskGB * GB, swap: swapGB * GB,
});
const system = (os, kernels) => ({ os, kernels });

const OS_COMMON_AMD64 = [
  system("Ubuntu 24.04.4 LTS", ["6.8.0-40-generic", "6.8.0-51-generic", "6.8.0-60-generic"]),
  system("Ubuntu 22.04.4 LTS", ["5.15.0-113-generic", "5.15.0-126-generic", "5.15.0-130-generic"]),
  system("Ubuntu 20.04.6 LTS", ["5.4.0-196-generic", "5.4.0-204-generic"]),
  system("Debian GNU/Linux 12 (bookworm)", ["6.1.0-21-amd64", "6.1.0-28-amd64", "6.1.0-31-amd64"]),
  system("Debian GNU/Linux 11 (bullseye)", ["5.10.0-30-amd64", "5.10.0-32-amd64"]),
];
const OS_COMMON_ARM64 = [
  system("Ubuntu 24.04.4 LTS", ["6.8.0-40-generic", "6.8.0-51-generic", "6.8.0-60-generic"]),
  system("Ubuntu 22.04.4 LTS", ["5.15.0-113-generic", "5.15.0-126-generic"]),
  system("Debian GNU/Linux 12 (bookworm)", ["6.1.0-21-arm64", "6.1.0-28-arm64", "6.1.0-31-arm64"]),
  system("Debian GNU/Linux 11 (bullseye)", ["5.10.0-30-arm64", "5.10.0-32-arm64"]),
];
const OS_ENTERPRISE_AMD64 = [
  system("Rocky Linux 9.3 (Blue Onyx)", ["5.14.0-427.el9.x86_64", "5.14.0-503.el9.x86_64"]),
  system("AlmaLinux 9.4 (Seafoam Ocelot)", ["5.14.0-427.el9.x86_64", "5.14.0-503.el9.x86_64"]),
  system("CentOS Stream 9", ["5.14.0-482.el9.x86_64", "5.14.0-503.el9.x86_64"]),
  system("Rocky Linux 8.10 (Green Obsidian)", ["4.18.0-553.el8_10.x86_64"]),
];
const OS_AWS_AMD64 = [
  system("Amazon Linux 2023", ["6.1.134-150.224.amzn2023.x86_64", "6.1.140-154.222.amzn2023.x86_64"]),
  system("Amazon Linux 2", ["5.10.234-225.910.amzn2.x86_64", "5.10.235-227.919.amzn2.x86_64"]),
  ...OS_COMMON_AMD64,
];
const OS_AWS_ARM64 = [
  system("Amazon Linux 2023", ["6.1.134-150.224.amzn2023.aarch64", "6.1.140-154.222.amzn2023.aarch64"]),
  system("Amazon Linux 2", ["5.10.234-225.910.amzn2.aarch64", "5.10.235-227.919.amzn2.aarch64"]),
  ...OS_COMMON_ARM64,
];
const OS_OCI_ARM64 = [
  system("Oracle Linux Server 9.4", ["5.15.0-303.171.5.2.el9uek.aarch64", "6.12.0-1.23.3.el9uek.aarch64"]),
  system("Oracle Linux Server 8.10", ["5.15.0-300.163.18.el8uek.aarch64", "5.15.0-303.171.5.2.el8uek.aarch64"]),
  ...OS_COMMON_ARM64,
];

const PROFILE_GROUPS = [
  {
    id: "budget-x86", label: "廉价 x86 VPS", weight: 28, arch: "amd64",
    cpus: [
      "Intel(R) Xeon(R) CPU E5-2620 v2 @ 2.10GHz", "Intel(R) Xeon(R) CPU E5-2630 v3 @ 2.40GHz",
      "Intel(R) Xeon(R) CPU E5-2630 v4 @ 2.20GHz", "Intel(R) Xeon(R) CPU E5-2640 v3 @ 2.60GHz",
      "Intel(R) Xeon(R) CPU E5-2640 v4 @ 2.40GHz", "Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz",
      "Intel(R) Xeon(R) CPU E5-2650 v3 @ 2.30GHz", "Intel(R) Xeon(R) CPU E5-2650 v4 @ 2.20GHz",
      "Intel(R) Xeon(R) CPU E5-2660 v2 @ 2.20GHz", "Intel(R) Xeon(R) CPU E5-2660 v3 @ 2.60GHz",
      "Intel(R) Xeon(R) CPU E5-2660 v4 @ 2.00GHz", "Intel(R) Xeon(R) CPU E5-2670 v2 @ 2.50GHz",
      "Intel(R) Xeon(R) CPU E5-2670 v3 @ 2.30GHz", "Intel(R) Xeon(R) CPU E5-2673 v3 @ 2.40GHz",
      "Intel(R) Xeon(R) CPU E5-2673 v4 @ 2.30GHz", "Intel(R) Xeon(R) CPU E5-2680 v2 @ 2.80GHz",
      "Intel(R) Xeon(R) CPU E5-2680 v3 @ 2.50GHz", "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz",
      "Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz", "Intel(R) Xeon(R) CPU E5-2690 v3 @ 2.60GHz",
      "Intel(R) Xeon(R) CPU E5-2690 v4 @ 2.60GHz", "Intel(R) Xeon(R) CPU E5-2696 v2 @ 2.50GHz",
      "Intel(R) Xeon(R) CPU E5-2696 v3 @ 2.30GHz", "Intel(R) Xeon(R) CPU E5-2696 v4 @ 2.20GHz",
      "Intel(R) Xeon(R) CPU E5-2697 v3 @ 2.60GHz", "Intel(R) Xeon(R) CPU E5-2697 v4 @ 2.30GHz",
      "Intel(R) Xeon(R) CPU E5-2698 v3 @ 2.30GHz", "Intel(R) Xeon(R) CPU E5-2698 v4 @ 2.20GHz",
      "AMD EPYC 7251 8-Core Processor", "AMD EPYC 7281 16-Core Processor",
      "AMD EPYC 7351P 16-Core Processor", "AMD EPYC 7401P 24-Core Processor", "AMD EPYC 7551P 32-Core Processor",
    ],
    systems: [...OS_COMMON_AMD64, system("Alpine Linux v3.20", ["6.6.32-0-lts", "6.6.46-0-lts"])],
    virts: ["kvm", "kvm", "kvm", "kvm", "openvz", "lxc"],
    sizes: [size(1,1,0.5,10), size(1,1,1,20), size(1,1,2,25), size(2,1,2,40), size(2,1,4,50), size(4,2,4,80), size(4,2,8,100)],
    gpus: ["", "", "", "", "Red Hat, Inc. Virtio GPU"], upKB: [1, 45], downKB: [3, 140],
  },
  {
    id: "modern-intel", label: "现代 Intel 云主机", weight: 14, arch: "amd64",
    cpus: [
      "Intel(R) Xeon(R) Silver 4110 CPU @ 2.10GHz", "Intel(R) Xeon(R) Silver 4210R CPU @ 2.40GHz",
      "Intel(R) Xeon(R) Silver 4310 CPU @ 2.10GHz", "Intel(R) Xeon(R) Gold 5118 CPU @ 2.30GHz",
      "Intel(R) Xeon(R) Gold 5120 CPU @ 2.20GHz", "Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz",
      "Intel(R) Xeon(R) Gold 6148 CPU @ 2.40GHz", "Intel(R) Xeon(R) Gold 6230R CPU @ 2.10GHz",
      "Intel(R) Xeon(R) Gold 6246R CPU @ 3.40GHz", "Intel(R) Xeon(R) Gold 6253CL CPU @ 3.10GHz",
      "Intel(R) Xeon(R) Gold 6268CL CPU @ 2.80GHz", "Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz",
      "Intel(R) Xeon(R) Platinum 8171M CPU @ 2.60GHz", "Intel(R) Xeon(R) Platinum 8173M CPU @ 2.00GHz",
      "Intel(R) Xeon(R) Platinum 8175M CPU @ 2.50GHz", "Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz",
      "Intel(R) Xeon(R) Platinum 8272CL CPU @ 2.60GHz", "Intel(R) Xeon(R) Platinum 8273CL CPU @ 2.20GHz",
      "Intel(R) Xeon(R) Platinum 8275CL CPU @ 3.00GHz", "Intel(R) Xeon(R) Platinum 8280L CPU @ 2.70GHz",
      "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz", "Intel(R) Xeon(R) Platinum 8373C CPU @ 2.60GHz",
      "Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz", "Intel(R) Xeon(R) Platinum 8473C",
      "Intel(R) Xeon(R) Platinum 8481C", "Intel(R) Xeon(R) Platinum 8490H",
      "Intel(R) Xeon(R) Platinum 8573C", "Intel(R) Xeon(R) Platinum 8581C", "Intel(R) Xeon(R) Platinum 6985P-C",
    ],
    systems: [...OS_COMMON_AMD64, ...OS_ENTERPRISE_AMD64], virts: ["kvm", "kvm", "kvm", "vmware"],
    sizes: [size(2,1,4,40), size(2,1,8,80), size(4,2,8,80), size(4,2,16,160), size(8,4,16,200), size(8,4,32,300), size(16,8,64,500)],
    gpus: ["", "", "", "Red Hat, Inc. Virtio GPU"], upKB: [8, 100], downKB: [20, 350],
  },
  {
    id: "modern-amd", label: "现代 AMD EPYC 云主机", weight: 16, arch: "amd64",
    cpus: [
      "AMD EPYC 7551 32-Core Processor", "AMD EPYC 7551P 32-Core Processor", "AMD EPYC 7402P 24-Core Processor",
      "AMD EPYC 7452 32-Core Processor", "AMD EPYC 7502P 32-Core Processor", "AMD EPYC 7642 48-Core Processor",
      "AMD EPYC 7742 64-Core Processor", "AMD EPYC 7B12", "AMD EPYC 7V12", "AMD EPYC 7B13",
      "AMD EPYC 7R13", "AMD EPYC 7R32", "AMD EPYC 7763", "AMD EPYC 7763v", "AMD EPYC 7V13",
      "AMD EPYC 7V73X", "AMD EPYC 9B14", "AMD EPYC 9B45", "AMD EPYC 9R14", "AMD EPYC 9R45",
      "AMD EPYC 9R05", "AMD EPYC 9V33X", "AMD EPYC 9J45",
    ],
    systems: [...OS_COMMON_AMD64, ...OS_ENTERPRISE_AMD64], virts: ["kvm", "kvm", "kvm", "vmware"],
    sizes: [size(2,1,4,40), size(2,1,8,80), size(4,2,8,80), size(4,2,16,160), size(8,4,16,200), size(8,4,32,300), size(16,8,64,500)],
    gpus: ["", "", "", "Red Hat, Inc. Virtio GPU"], upKB: [8, 110], downKB: [20, 380],
  },
  {
    id: "aws-x86", label: "AWS EC2 x86", weight: 7, arch: "amd64",
    cpus: [
      "Intel(R) Xeon(R) Platinum 8175M CPU @ 2.50GHz", "Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz",
      "Intel(R) Xeon(R) Platinum 8275CL CPU @ 3.00GHz", "Intel Xeon Ice Lake", "Intel Xeon Sapphire Rapids",
      "Intel Xeon Granite Rapids", "AMD EPYC 7R13", "AMD EPYC 7R32", "AMD EPYC 9R14", "AMD EPYC 9R45", "AMD EPYC 9R05",
    ],
    systems: OS_AWS_AMD64, virts: ["amazon"],
    sizes: [size(1,1,1,8), size(1,1,2,20), size(2,1,4,30), size(4,2,8,50), size(4,2,16,100), size(8,4,32,160), size(16,8,64,320)],
    gpus: [""], upKB: [10, 120], downKB: [25, 420],
  },
  {
    id: "aws-arm", label: "AWS Graviton", weight: 5, arch: "arm64",
    cpus: ["AWS Graviton2 Processor", "AWS Graviton3 Processor", "AWS Graviton3E Processor", "AWS Graviton4 Processor"],
    systems: OS_AWS_ARM64, virts: ["amazon"],
    sizes: [size(1,1,1,8), size(1,1,2,20), size(2,2,4,30), size(4,4,8,50), size(4,4,16,100), size(8,8,32,160), size(16,16,64,320)],
    gpus: [""], upKB: [10, 120], downKB: [25, 420],
  },
  {
    id: "gcp-x86", label: "Google Cloud x86", weight: 6, arch: "amd64",
    cpus: [
      "Intel(R) Xeon(R) CPU E5-2689 @ 2.60GHz", "Intel(R) Xeon(R) CPU E5-2696 v2 @ 2.50GHz",
      "Intel(R) Xeon(R) CPU E5-2696 v3 @ 2.30GHz", "Intel(R) Xeon(R) CPU E5-2696 v4 @ 2.20GHz",
      "Intel(R) Xeon(R) CPU E7-8880 v4 @ 2.20GHz", "Intel(R) Xeon(R) Platinum 8173M CPU @ 2.00GHz",
      "Intel(R) Xeon(R) Platinum 8273CL CPU @ 2.20GHz", "Intel(R) Xeon(R) Platinum 8280L CPU @ 2.70GHz",
      "Intel(R) Xeon(R) Gold 6253CL CPU @ 3.10GHz", "Intel(R) Xeon(R) Gold 6268CL CPU @ 2.80GHz",
      "Intel(R) Xeon(R) Platinum 8373C CPU @ 2.60GHz", "Intel(R) Xeon(R) Platinum 8481C",
      "Intel(R) Xeon(R) Platinum 8490H", "Intel(R) Xeon(R) Platinum 8581C", "Intel(R) Xeon(R) Platinum 6985P-C",
      "AMD EPYC 7B12", "AMD EPYC 7B13", "AMD EPYC 9B14", "AMD EPYC 9B45",
    ],
    systems: [...OS_COMMON_AMD64, ...OS_ENTERPRISE_AMD64], virts: ["kvm"],
    sizes: [size(1,1,1,10), size(1,1,2,20), size(2,1,4,30), size(4,2,8,50), size(4,2,16,100), size(8,4,32,200), size(16,8,64,400)],
    gpus: [""], upKB: [10, 120], downKB: [25, 420],
  },
  {
    id: "gcp-arm", label: "Google Cloud ARM", weight: 3, arch: "arm64",
    cpus: ["Ampere Altra Q64-30", "Google Axion Processor", "NVIDIA Grace Processor"],
    systems: OS_COMMON_ARM64, virts: ["kvm"],
    sizes: [size(1,1,2,10), size(2,2,4,20), size(4,4,8,50), size(8,8,16,100), size(16,16,32,200)],
    gpus: [""], upKB: [10, 120], downKB: [25, 420],
  },
  {
    id: "azure-x86", label: "Microsoft Azure x86", weight: 6, arch: "amd64",
    cpus: [
      "Intel(R) Xeon(R) CPU E5-2673 v3 @ 2.40GHz", "Intel(R) Xeon(R) CPU E5-2673 v4 @ 2.30GHz",
      "Intel(R) Xeon(R) CPU E5-2690 v3 @ 2.60GHz", "Intel(R) Xeon(R) CPU E5-2690 v4 @ 2.60GHz",
      "Intel(R) Xeon(R) CPU E5-2698 v3 @ 2.30GHz", "Intel(R) Xeon(R) CPU E5-2698B v3 @ 2.00GHz",
      "Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz", "Intel(R) Xeon(R) Platinum 8171M CPU @ 2.60GHz",
      "Intel(R) Xeon(R) Platinum 8272CL CPU @ 2.60GHz", "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz",
      "Intel(R) Xeon(R) Platinum 8473C", "Intel(R) Xeon(R) Platinum 8573C",
      "AMD EPYC 7551", "AMD EPYC 7452", "AMD EPYC 7V12", "AMD EPYC 7742", "AMD EPYC 7763",
      "AMD EPYC 7763v", "AMD EPYC 7V13", "AMD EPYC 7V73X", "AMD EPYC 9V33X", "AMD EPYC 9004", "AMD EPYC 9005",
    ],
    systems: [...OS_COMMON_AMD64, ...OS_ENTERPRISE_AMD64], virts: ["microsoft"],
    sizes: [size(1,1,1,30), size(1,1,2,30), size(2,1,4,64), size(4,2,8,128), size(4,2,16,128), size(8,4,32,256), size(16,8,64,512)],
    gpus: [""], upKB: [10, 120], downKB: [25, 420],
  },
  {
    id: "azure-arm", label: "Microsoft Azure ARM", weight: 2, arch: "arm64",
    cpus: ["Ampere Altra", "Microsoft Azure Cobalt 100"], systems: OS_COMMON_ARM64, virts: ["microsoft"],
    sizes: [size(2,2,4,30), size(4,4,8,64), size(8,8,16,128), size(16,16,32,256)],
    gpus: [""], upKB: [10, 120], downKB: [25, 420],
  },
  {
    id: "oci-arm", label: "Oracle Cloud ARM", weight: 4, arch: "arm64",
    cpus: ["Ampere(R) Altra(R) Q80-30", "Ampere Altra Q80-30", "Ampere AmpereOne A160-30", "Ampere AmpereOne M A06-36M", "Ampere AmpereOne M 192-36M"],
    systems: OS_OCI_ARM64, virts: ["kvm"],
    sizes: [size(1,1,6,50), size(2,2,12,50), size(4,4,24,100), size(8,8,48,200), size(16,16,96,400)],
    gpus: [""], upKB: [8, 100], downKB: [20, 360],
  },
  {
    id: "enterprise-vmware", label: "企业 VMware/KVM", weight: 4, arch: "amd64",
    cpus: [
      "Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz", "Intel(R) Xeon(R) Gold 6148 CPU @ 2.40GHz",
      "Intel(R) Xeon(R) Gold 6230R CPU @ 2.10GHz", "Intel(R) Xeon(R) Gold 6246R CPU @ 3.40GHz",
      "Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz", "Intel(R) Xeon(R) Platinum 8272CL CPU @ 2.60GHz",
      "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz", "AMD EPYC 7402P 24-Core Processor",
      "AMD EPYC 7452 32-Core Processor", "AMD EPYC 7502P 32-Core Processor", "AMD EPYC 7763",
    ],
    systems: [...OS_ENTERPRISE_AMD64, ...OS_COMMON_AMD64], virts: ["vmware", "vmware", "kvm"],
    sizes: [size(2,1,4,60), size(4,2,8,100), size(4,2,16,160), size(8,4,32,300), size(16,8,64,600)],
    gpus: ["", "", "VMware SVGA II Adapter"], upKB: [5, 80], downKB: [15, 260],
  },
  {
    id: "dedicated-x86", label: "独服/家用机", weight: 5, arch: "amd64",
    cpus: [
      "Intel(R) Xeon(R) CPU E3-1230 v3 @ 3.30GHz", "Intel(R) Xeon(R) CPU E3-1240 v5 @ 3.50GHz",
      "Intel(R) Xeon(R) E-2146G CPU @ 3.50GHz", "Intel(R) Xeon(R) E-2288G CPU @ 3.70GHz",
      "AMD EPYC 7302P 16-Core Processor", "AMD EPYC 7402P 24-Core Processor", "AMD EPYC 7443P 24-Core Processor",
      "AMD EPYC 7513 32-Core Processor", "AMD Ryzen 5 3600 6-Core Processor", "AMD Ryzen 5 5600X 6-Core Processor",
      "AMD Ryzen 7 3700X 8-Core Processor", "AMD Ryzen 7 5700X 8-Core Processor",
      "AMD Ryzen 9 3900X 12-Core Processor", "AMD Ryzen 9 5900X 12-Core Processor",
      "AMD Ryzen 9 5950X 16-Core Processor", "AMD Ryzen 9 7900 12-Core Processor", "AMD Ryzen 9 7950X 16-Core Processor",
      "Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz", "Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz",
      "Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz", "Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz",
      "Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz", "Intel(R) Core(TM) i9-12900K", "Intel(R) Core(TM) i9-13900K",
    ],
    systems: [...OS_COMMON_AMD64, ...OS_ENTERPRISE_AMD64], virts: ["none", "none", "kvm", "vmware"],
    sizes: [size(4,4,16,240), size(6,6,32,480), size(8,8,32,500), size(12,12,64,1000), size(16,16,64,1000), size(16,16,128,2000)],
    gpus: ["", "", "", "Intel Corporation UHD Graphics"], upKB: [20, 220], downKB: [50, 700],
  },
];

function weightedPick(rng, groups) {
  const total = groups.reduce((n, g) => n + Math.max(0, g.weight || 0), 0);
  let cursor = rng() * total;
  for (const g of groups) {
    cursor -= Math.max(0, g.weight || 0);
    if (cursor < 0) return g;
  }
  return groups[groups.length - 1];
}
function inferArchFromCpu(name) {
  if (!name) return "";
  return /(graviton|ampere|neoverse|axion|grace|cobalt|aarch64|arm64)/i.test(name) ? "arm64" : "amd64";
}
function selectProfileGroup(rng, ov) {
  const requested = String(ov.group || "").trim().toLowerCase();
  if (requested) {
    const exact = PROFILE_GROUPS.find((g) => g.id === requested);
    if (exact) return exact;
  }
  const archHint = String(ov.arch || inferArchFromCpu(ov.cpu) || "").toLowerCase();
  const candidates = archHint ? PROFILE_GROUPS.filter((g) => g.arch === archHint) : PROFILE_GROUPS;
  return weightedPick(rng, candidates.length ? candidates : PROFILE_GROUPS);
}
function customKernelCandidates(os, arch) {
  const arm = arch === "arm64";
  const s = String(os || "").toLowerCase();
  if (s.includes("ubuntu 24")) return ["6.8.0-40-generic", "6.8.0-51-generic", "6.8.0-60-generic"];
  if (s.includes("ubuntu 22")) return ["5.15.0-113-generic", "5.15.0-126-generic", "5.15.0-130-generic"];
  if (s.includes("ubuntu 20")) return ["5.4.0-196-generic", "5.4.0-204-generic"];
  if (s.includes("debian") && s.includes("12")) return arm ? ["6.1.0-21-arm64", "6.1.0-28-arm64"] : ["6.1.0-21-amd64", "6.1.0-28-amd64"];
  if (s.includes("debian") && s.includes("11")) return arm ? ["5.10.0-30-arm64", "5.10.0-32-arm64"] : ["5.10.0-30-amd64", "5.10.0-32-amd64"];
  if (s.includes("alpine")) return ["6.6.32-0-lts", "6.6.46-0-lts"];
  if (s.includes("rocky") || s.includes("alma") || s.includes("centos")) return arm ? ["5.14.0-427.el9.aarch64", "5.14.0-503.el9.aarch64"] : ["5.14.0-427.el9.x86_64", "5.14.0-503.el9.x86_64"];
  return [];
}

// ov: 用户自定义。未指定字段时，全部从同一个模板组内生成。
function buildProfile(token, ov = {}) {
  const rng = mulberry32(hash32("globe:" + token));
  const group = selectProfileGroup(rng, ov);
  const chosenSystem = pick(rng, group.systems);
  const chosenSize = pick(rng, group.sizes);
  const arch = ov.arch || group.arch;
  const cpuName = ov.cpu || pick(rng, group.cpus);
  const osName = ov.os || chosenSystem.os;
  const customKernels = ov.os ? customKernelCandidates(osName, arch) : [];
  const kernel = ov.kernel || pick(rng, customKernels.length ? customKernels : chosenSystem.kernels);
  const cores = ov.cores || chosenSize.cores;
  const pcores = ov.pcores || (ov.cores
    ? (arch === "arm64" ? cores : Math.max(1, rng() < 0.55 ? cores : Math.ceil(cores / 2)))
    : chosenSize.pcores);
  const octet = () => Math.floor(rng() * 256), h16 = () => Math.floor(rng() * 65536).toString(16);
  const ip4 = ov.ip4 || `100.${64 + Math.floor(rng() * 64)}.${octet()}.${1 + Math.floor(rng() * 254)}`;
  const ip6 = ov.ip6 || `2001:db8:${h16()}:${h16()}:${h16()}::${(1 + Math.floor(rng() * 65534)).toString(16)}`;
  let ipMode = (ov.ipmode || "v4").toLowerCase();
  if (ipMode === "mix" || ipMode === "random") {
    const r = (hash32("ipm:" + token) % 1000) / 1000;
    ipMode = r < 0.55 ? "both" : (r < 0.95 ? "v4" : "v6");
  }
  const randomRate = (range) => Math.floor((range[0] + rng() * (range[1] - range[0])) * 1024);
  return {
    profile_group: group.id,
    profile_label: group.label,
    cpu_name: cpuName,
    arch,
    cpu_cores: cores,
    cpu_physical_cores: pcores,
    os: osName,
    kernel_version: kernel,
    virtualization: ov.virt || pick(rng, group.virts),
    gpu_name: ov.gpu != null ? ov.gpu : pick(rng, group.gpus || [""]),
    mem_total: ov.mem != null ? ov.mem : chosenSize.mem,
    swap_total: ov.swap != null ? ov.swap : chosenSize.swap,
    disk_total: ov.disk != null ? ov.disk : chosenSize.disk,
    ip4, ip6, ipMode,

    upRate: ov.uprate != null ? ov.uprate : randomRate(group.upKB || [1, 60]),
    downRate: ov.downrate != null ? ov.downrate : randomRate(group.downKB || [2, 180]),
    baseUp: Math.floor(rng() * 20) * GB,
    baseDown: Math.floor(rng() * 40) * GB,
    memUsedFrac: 0.2 + rng() * 0.45,
    diskUsedFrac: 0.15 + rng() * 0.5,
    procBase: Math.floor(40 + rng() * 160),
    cpuBase: 5 + rng() * 18, cpuAmp: 10 + rng() * 26,
    pA: 20 + rng() * 30, pB: 120 + rng() * 200,
    phCpu: rng() * 6.283, phNet: rng() * 6.283, phMem: rng() * 6.283,
    pNet: 3 + rng() * 6,
    pMem: 60 + rng() * 140,
  };
}


// 从 URL 参数 / 环境变量解析全局自定义配置(不填=随机)
function overrides(url, env) {
  const q = (k) => { const v = url.searchParams.get(k); return v == null || v === "" ? undefined : v; };
  const num = (v) => v == null ? undefined : parseInt(v, 10);
  const bytes = (v) => v == null ? undefined : Math.round(parseFloat(v) * GB); // 单位: GB
  const kbps = (v) => v == null ? undefined : Math.round(parseFloat(v) * 1024); // 单位: KB/s -> B/s
  return {
    group: (((q("group") ?? env.SPEC_GROUP) || "").trim().toLowerCase()) || undefined,
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
    gpu_name: p.gpu_name, virtualization: p.virtualization, version: "komari-globe/2.0-grouped",
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

async function reprofileAgents(env, c, opts) {
  const agents = await loadAgents(env);
  const offset = Math.max(0, parseInt(opts.offset || 0, 10));
  const limit = Math.max(1, Math.min(40, parseInt(opts.limit || 40, 10)));
  const end = Math.min(agents.length, offset + limit);
  let ok = 0;
  const failed = [];
  for (let i = offset; i < end; i++) {
    const a = agents[i];
    try {
      const p = buildProfile(a.token, opts.ov || {});
      await komariRpc(c.server, a.token, "agent.basicInfo", { info: basicInfo(a.country, p) }, `rp${Date.now()}-${i}`);
      a.p = p;
      ok++;
    } catch (e) {
      failed.push(`${a.country || i}: ${e.message}`);
    }
  }
  await saveAgents(env, agents);
  const nextOffset = end < agents.length ? end : null;
  return { total: agents.length, offset, processed: end - offset, ok, failed, nextOffset };
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
.wrap{max-width:900px;margin:0 auto;padding:20px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 16px;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
.card h2{font-size:14px;margin:0 0 12px;color:var(--acc)}
label{display:block;font-size:12px;color:var(--mut);margin:8px 0 2px}
input,select{width:100%;padding:8px 10px;background:#0d1024;border:1px solid var(--line);border-radius:8px;color:var(--fg);font-size:13px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.row4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px}
.chk{display:flex;align-items:center;gap:6px;margin-top:10px}.chk input{width:auto}
button{cursor:pointer;border:0;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;color:#fff;background:var(--acc);margin:10px 6px 0 0}
button.g{background:#2a3152}button.r{background:var(--err)}button.s{padding:4px 9px;margin:0;font-size:12px}button:active{transform:translateY(1px)}
pre{background:#0a0c1a;border:1px solid var(--line);border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-all;min-height:40px;margin:14px 0 0;font-size:12px}
small{color:var(--mut)}a{color:var(--acc)}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--mut);font-weight:500}
tr:hover td{background:#0d1024}.mono{font-family:ui-monospace,Consolas,monospace}
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px}
.tab{background:#0d1024;border:1px solid var(--line);color:var(--mut);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px}
.tab.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.hide{display:none}.env{font-family:ui-monospace,monospace;font-size:12px}
.badge{display:inline-block;padding:1px 7px;border-radius:6px;font-size:11px;background:#0d1024;border:1px solid var(--line);margin-left:6px}
</style></head><body><div class="wrap">
<h1>komari 点亮全球 <small id="cnt"></small></h1>
<p class="sub">可视化控制台 · 全部操作在本地拼接并调用本 worker 接口</p>

<div class="card"><h2>访问口令</h2>
<label>ACCESS_KEY（后台设了才需要，浏览器本地保存）</label>
<input id="key" placeholder="没设就留空" autocomplete="off">
</div>

<div class="tabs">
<div class="tab on" data-t="reg">注册</div>
<div class="tab" data-t="setup">Token 接入</div>
<div class="tab" data-t="list">探针列表</div>
<div class="tab" data-t="ops">保活 / 运维</div>
<div class="tab" data-t="help">环境变量 / 帮助</div>
</div>

<div class="card pane" id="p-reg"><h2>注册探针（用自动发现密钥自动建号）</h2>
<label>国家代码（逗号分隔；留空=内置 ~200 个；同一国家写多次+勾选重复可多开）</label>
<input id="countries" placeholder="US,JP,DE,GB,FR,AQ">
<div class="row4">
<div><label>机器模板组</label><select id="group">
<option value="">自动按权重分配</option>
<option value="budget-x86">廉价 x86 VPS</option>
<option value="modern-intel">现代 Intel 云主机</option>
<option value="modern-amd">现代 AMD EPYC</option>
<option value="aws-x86">AWS EC2 x86</option>
<option value="aws-arm">AWS Graviton</option>
<option value="gcp-x86">Google Cloud x86</option>
<option value="gcp-arm">Google Cloud ARM</option>
<option value="azure-x86">Azure x86</option>
<option value="azure-arm">Azure ARM</option>
<option value="oci-arm">Oracle Cloud ARM</option>
<option value="enterprise-vmware">企业 VMware/KVM</option>
<option value="dedicated-x86">独服/家用机</option>
</select></div>
<div><label>IP 模式</label><select id="ipmode"><option value="">默认(v4)</option><option>v4</option><option>v6</option><option>both</option><option>mix</option></select></div>
<div><label>每次数量 limit</label><input id="limit" placeholder="20"></div>
<div><label>固定 IPv4 ip4（可选）</label><input id="ip4" placeholder="随机"></div>
</div>
<div class="row4">
<div><label>核数 cores</label><input id="cores" placeholder="随机"></div>
<div><label>物理核 pcores</label><input id="pcores" placeholder="随机"></div>
<div><label>内存 GB</label><input id="mem" placeholder="随机"></div>
<div><label>磁盘 GB</label><input id="disk" placeholder="随机"></div>
</div>
<div class="row4">
<div><label>交换 GB swap</label><input id="swap" placeholder="随机"></div>
<div><label>下行 KB/s</label><input id="downrate" placeholder="随机"></div>
<div><label>上行 KB/s</label><input id="uprate" placeholder="随机"></div>
<div><label>固定 IPv6 ip6（可选）</label><input id="ip6" placeholder="随机"></div>
</div>
<div class="row3">
<div><label>CPU 型号 cpu</label><input id="cpu" placeholder="随机"></div>
<div><label>系统 os</label><input id="os" placeholder="随机"></div>
<div><label>虚拟化 virt</label><input id="virt" placeholder="随机"></div>
</div>
<div class="row3">
<div><label>架构 arch</label><input id="arch" placeholder="随机"></div>
<div><label>GPU gpu</label><input id="gpu" placeholder="随机/空"></div>
<div><label>内核 kernel</label><input id="kernel" placeholder="随机"></div>
</div>
<label class="chk"><input type="checkbox" id="force"> 允许重复国家 / 覆盖重建 (force)</label>
<button onclick="reg()">注册 / 继续注册</button>
<button class="g" onclick="regAll()">一键注册全部 ~200</button>
</div>

<div class="card pane hide" id="p-setup"><h2>用已有 token 接入（无需自动发现密钥）</h2>
<label>tokens（格式 token:US,token2:JP，冒号后是国家代码）</label>
<input id="tokens" placeholder="Pf8xxxx:US,abcd:JP">
<small>把 komari 一键部署命令里 -t 后面那串填进来，冒号后跟想挂的国家。可套用上方“注册”表单里的配置项。</small>
<button onclick="setup()">接入</button>
</div>

<div class="card pane hide" id="p-list"><h2>探针列表 <button class="g s" onclick="loadList()">刷新</button></h2>
<div id="tbl"><small>点“刷新”加载。</small></div>
</div>

<div class="card pane hide" id="p-ops"><h2>保活 / 运维</h2>
<div class="row3">
<div><label>rounds（轮数）</label><input id="d_rounds" placeholder="1"></div>
<div><label>gap（间隔秒）</label><input id="d_gap" placeholder="0"></div>
<div><label>&nbsp;</label><button onclick="drive()">立即保活/扇出一次</button></div>
</div>
<button class="g" onclick="go('/status')">查看状态(文本)</button>
<button class="g" onclick="go('/report')">直连保活一轮</button>
<hr style="border-color:var(--line);margin:16px 0">
<h2>重建已有探针画像</h2>
<small>旧 KV 中保存的乱搭配置不会自动变化。每批最多 40 台，按 offset 分批重建，并立即推送到面板。</small>
<div class="row3">
<div><label>offset（从第几台开始）</label><input id="rp_offset" placeholder="0"></div>
<div><label>limit（每批最多 40）</label><input id="rp_limit" placeholder="40"></div>
<div><label>&nbsp;</label><button onclick="reprofile()">重建这一批画像</button></div>
</div>
<hr style="border-color:var(--line);margin:16px 0">
<label>按国家移除（仅从 KV 移除，面板上仍需手动删）</label>
<input id="rmc" placeholder="US,JP">
<button class="r" onclick="rm()">移除这些国家</button>
<button class="r" onclick="if(confirm('清空 KV 全部记录? 面板探针不受影响'))go('/reset')">清空全部 KV</button>
</div>

<div class="card pane hide" id="p-help"><h2>环境变量（在 CF 后台 Settings→Variables 设置）</h2>
<table><tr><th>变量</th><th>作用</th></tr>
<tr><td class="env">KOMARI_KV</td><td>KV 绑定（必须，存探针）</td></tr>
<tr><td class="env">KOMARI_SERVER</td><td>面板地址（必须）</td></tr>
<tr><td class="env">KOMARI_ADKEY</td><td>自动发现密钥（走注册需要）</td></tr>
<tr><td class="env">ACCESS_KEY</td><td>控制台/写操作口令</td></tr>
<tr><td class="env">SELF</td><td>Service binding 绑到自身（开扇出，推荐）</td></tr>
<tr><td class="env">SELF_URL</td><td>本 worker 地址（无 SELF 绑定时的退路）</td></tr>
<tr><td class="env">SHARD_SIZE</td><td>每分片探针数，默认 40</td></tr>
<tr><td class="env">CRON_ROUNDS / CRON_GAP</td><td>每分钟上报轮数 / 间隔秒（如 28/2 ≈ 每 2 秒）</td></tr>
<tr><td class="env">SPEC_GROUP</td><td>固定机器模板组，如 aws-arm、budget-x86；留空则按权重稳定分配</td></tr>
<tr><td class="env">SPEC_*</td><td>画像字段覆盖：SPEC_CPU/CORES/MEM/DISK/OS/IPMODE/UPRATE… </td></tr>
</table>
<p><small>路由：/register /setup /reprofile /report /drive /status /list /remove /reset。开源：
<a href="https://github.com/TyrEamon/komari-LUTW" target="_blank">TyrEamon/komari-LUTW</a></small></p>
</div>

<pre id="out">就绪。</pre>
</div><script>
const $=id=>document.getElementById(id);
$('key').value=localStorage.getItem('k')||'';
$('key').oninput=e=>localStorage.setItem('k',e.target.value);
const out=$('out');
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));t.classList.add('on');
  document.querySelectorAll('.pane').forEach(p=>p.classList.add('hide'));
  $('p-'+t.dataset.t).classList.remove('hide');
  if(t.dataset.t==='list')loadList();
});
function qs(o){const p=[];for(const k in o){const v=o[k];if(v!==''&&v!=null)p.push(k+'='+encodeURIComponent(v))}const kk=$('key').value.trim();if(kk)p.push('key='+encodeURIComponent(kk));return p.length?'?'+p.join('&'):''}
async function call(path){out.textContent='请求中…';try{const r=await fetch(path);const t=await r.text();out.textContent=t;refresh()}catch(e){out.textContent='出错: '+e}}
function go(p){const kk=$('key').value.trim();call(p+(p.includes('?')?'&':'?')+(kk?'key='+encodeURIComponent(kk):''))}
function spec(){return{group:$('group').value,ipmode:$('ipmode').value,cores:$('cores').value.trim(),pcores:$('pcores').value.trim(),mem:$('mem').value.trim(),disk:$('disk').value.trim(),swap:$('swap').value.trim(),downrate:$('downrate').value.trim(),uprate:$('uprate').value.trim(),cpu:$('cpu').value.trim(),os:$('os').value.trim(),virt:$('virt').value.trim(),arch:$('arch').value.trim(),gpu:$('gpu').value.trim(),kernel:$('kernel').value.trim(),ip4:$('ip4').value.trim(),ip6:$('ip6').value.trim()}}
function reg(){call('/register'+qs(Object.assign({countries:$('countries').value.trim(),limit:$('limit').value.trim(),force:$('force').checked?'1':''},spec())))}
function regAll(){if(confirm('注册内置全部 ~200 个国家? 会分批, 多点几次直到“全部完成”'))call('/register'+qs(Object.assign({limit:'40',force:$('force').checked?'1':''},spec())))}
function setup(){call('/setup'+qs(Object.assign({tokens:$('tokens').value.trim()},spec())))}
function drive(){go('/drive?rounds='+($('d_rounds').value.trim()||'1')+'&gap='+($('d_gap').value.trim()||'0'))}
function reprofile(){call('/reprofile'+qs(Object.assign({offset:$('rp_offset').value.trim()||'0',limit:$('rp_limit').value.trim()||'40'},spec())))}
function rm(){const c=$('rmc').value.trim();if(!c)return;if(confirm('从 KV 移除 '+c+' ?'))call('/remove'+qs({countries:c}))}
function fmtB(b){b=+b;return b>=1073741824?(b/1073741824).toFixed(0)+'G':b?(b/1048576).toFixed(0)+'M':'-'}
async function loadList(){const box=$('tbl');box.innerHTML='加载中…';try{const r=await fetch('/list');const j=await r.json();
  if(!j.count){box.innerHTML='<small>还没有探针。去“注册”标签建一些。</small>';return}
  const on=j.agents.filter(a=>a.online===true).length;
  let h='<div class="sub">共 '+j.count+' 台'+(j.onlineKnown?' · 在线 '+on+' · 离线 '+(j.count-on):' · (面板在线态不可用)')+'</div>';
  h+='<table><tr><th>状态</th><th>国</th><th>类型</th><th>IP</th><th>配置</th><th>系统</th><th></th></tr>';
  for(const a of j.agents){const ip=a.ipMode==='v6'?a.ip6:(a.ipMode==='both'?a.ip4+' / v6':a.ip4);
    const st=a.online===true?'<span style="color:var(--ok)">●在线</span>':(a.online===false?'<span style="color:var(--err)">●离线</span>':'<span style="color:var(--mut)">–</span>');
    h+='<tr><td>'+st+'</td><td>'+a.flag+' '+a.country+'</td><td>'+(a.profileLabel||a.profileGroup||'-')+'</td><td class="mono">'+ip+'</td><td>'+a.cores+'核 '+fmtB(a.mem)+' '+fmtB(a.disk)+'</td><td>'+(a.os||'-')+'</td><td><button class="r s" onclick="rmTok(\\''+a.token+'\\',\\''+a.country+'\\')">✕</button></td></tr>'}
  h+='</table>';box.innerHTML=h;}catch(e){box.innerHTML='加载失败: '+e}}
function rmTok(tok,cc){if(!confirm('移除 '+cc+' 这一台?'))return;call('/remove'+qs({tokens:tok})).then(loadList)}
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
  const gated = (p) => c.accessKey && url.searchParams.get("key") !== c.accessKey && ["/register", "/setup", "/reprofile", "/remove", "/reset"].includes(p);

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

    if (path === "/reprofile") {
      if (!c.server) return txt("❌ 缺少 server(URL 参数或 KOMARI_SERVER)", 400);
      const r = await reprofileAgents(env, c, {
        offset: url.searchParams.get("offset") || "0",
        limit: url.searchParams.get("limit") || "40",
        ov: overrides(url, env),
      });
      return txt(`✅ 已重建 ${r.ok}/${r.processed} 台画像（总计 ${r.total} 台，当前 offset=${r.offset}）` +
        (r.nextOffset != null ? `\n下一批请用 offset=${r.nextOffset}&limit=40` : "\n全部处理完成") +
        (r.failed.length ? `\n失败 ${r.failed.length}:\n` + r.failed.join("\n") : ""));
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
      const counts = {};
      for (const a of agents) {
        const name = (a.p && (a.p.profile_label || a.p.profile_group)) || "旧版未分组";
        counts[name] = (counts[name] || 0) + 1;
      }
      const groups = Object.entries(counts).map(([name, n]) => `${name}: ${n}`).join(" | ");
      return txt(`已注册 ${agents.length} 个探针:
` + agents.map((a) => a.country + flagEmoji(a.country)).join(" ") +
        (groups ? `

模板分布:
${groups}` : ""));
    }

    if (path === "/list") {
      // 结构化列表(供控制台渲染带删除按钮的探针表)
      const agents = await loadAgents(env);
      // 顺带拉一次面板公开接口, 标出每台真实在线状态(uuid -> online)
      let onlineSet = null;
      if (c.server) {
        try {
          const rr = await fetch(`${c.server}/api/rpc2`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "common:getNodesLatestStatus", params: {} }),
          });
          const jj = await rr.json().catch(() => null);
          const data = jj && jj.result;
          if (data && typeof data === "object") {
            onlineSet = new Set();
            for (const uuid in data) if (data[uuid] && data[uuid].online) onlineSet.add(uuid);
          }
        } catch (e) { /* 面板不可达就不显示在线态 */ }
      }
      const list = agents.map((a) => {
        const p = a.p || {};
        return {
          country: a.country, flag: flagEmoji(a.country), token: a.token, uuid: a.uuid || "",
          online: onlineSet ? onlineSet.has(a.uuid) : null,
          ipMode: p.ipMode || "v4", ip4: p.ip4 || "", ip6: p.ip6 || "",
          profileGroup: p.profile_group || "", profileLabel: p.profile_label || "",
          cpu: p.cpu_name || "", cores: p.cpu_cores || 0,
          mem: p.mem_total || 0, disk: p.disk_total || 0, os: p.os || "",
        };
      });
      return new Response(JSON.stringify({ count: list.length, onlineKnown: onlineSet !== null, agents: list }),
        { headers: { "content-type": "application/json; charset=utf-8" } });
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

    return txt("komari 点亮全球\n路由: /register  /setup?tokens=tok:US  /reprofile  /report  /drive  /status  /remove?countries=US,JP  /reset\n先设 KOMARI_SERVER, 注册好探针, 再让 cron 定时打");
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


