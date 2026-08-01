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
// 真实机器大多有 swap(常见 512M~4G, 也有约 1/4 无 swap)。size() 未显式给 swap 时按内存推一个合理值。
function defaultSwap(rng, memBytes) {
  const r = rng();
  if (r < 0.22) return 0;                          // ~22% 无 swap
  const mem = memBytes || GB;
  const opts = mem <= GB ? [512 * MB, 1 * GB, mem]
    : mem <= 4 * GB ? [512 * MB, 1 * GB, 2 * GB, mem]
    : [1 * GB, 2 * GB, 4 * GB, 8 * GB];
  return opts[Math.floor(rng() * opts.length)];
}

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
  // 上/下行不再各自独立随机(会导致累计流量 2GB vs 29GB 这种夸张不对等)。
  // 先定一个平均上行速率, 再乘一个"每台稳定"的方向比例: 多数机器下行>上行(拉取型),
  // 少数上行>下行(回源/上传型), 但比例克制在 0.5~2.3 倍, 累计流量随之温和分化。
  const upR = ov.uprate != null ? ov.uprate : randomRate(group.upKB || [1, 60]);
  const netRatio = 0.5 + rng() * 1.8;               // <1: 上行多; >1: 下行多
  const dnR = ov.downrate != null ? ov.downrate : Math.floor(upR * netRatio);
  const baseGB = rng() * 20;                          // 起始累计上行(GB), 下行按同比例
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
    swap_total: ov.swap != null ? ov.swap : (chosenSize.swap || defaultSwap(rng, chosenSize.mem)),
    disk_total: ov.disk != null ? ov.disk : chosenSize.disk,
    ip4, ip6, ipMode,

    // 上/下行: 每台按稳定比例派生方向偏向(0.5~2.3x), 有的上行多有的下行多, 但不夸张对等
    upRate: ov.uprate != null ? ov.uprate : upR,
    downRate: ov.downrate != null ? ov.downrate : dnR,
    baseUp: Math.floor(baseGB) * GB,
    baseDown: Math.floor(baseGB * netRatio) * GB,
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

// ---- 免费版容量测算 ----
// 决定"能挂多少探针"的三个 CF 免费版硬限制:
//   1) 每账号 10 万次请求/天(所有 worker 共享)。cron 每分钟触发 1 次, 每次触发内部产生
//      「1 次调度 + 分片数 × CRON_ROUNDS 次 /report 请求」, 全天 = 1440 × (1 + shards×ROUNDS)。
//   2) 单次调用最多 50 个外部子请求 => 单分片探针数 SHARD_SIZE ≤ 45(留余量)。
//   3) CRON_ROUNDS × CRON_GAP 要 ≤ ~50 秒(每分钟内跑得完)。
// 预留 ~10% 请求额度给控制台/ /list / /status / 手动 /report。设 PLAN=paid 解除数量上限。
function capacity(env) {
  const shardSize = Math.max(1, parseInt(env.SHARD_SIZE || "40", 10));
  const rounds = Math.max(1, parseInt(env.CRON_ROUNDS || "2", 10));
  const gap = Math.max(0, parseInt(env.CRON_GAP || "30", 10));
  const paid = String(env.PLAN || "").toLowerCase() === "paid";
  const DAILY = 90000;                          // 10 万/天预留 1 万给杂项
  const effShard = paid ? shardSize : Math.min(shardSize, 45);   // 50 外部子请求上限
  const maxShards = paid ? Infinity : Math.max(1, Math.floor((DAILY / 1440 - 1) / rounds));
  const maxProbes = paid ? Infinity : maxShards * effShard;
  const gapOk = (rounds - 1) * gap <= 55;       // 间隔只在轮次之间, N 轮有 N-1 个间隔
  return { shardSize, effShard, rounds, gap, paid, maxShards, maxProbes, gapOk };
}

// ---- 业务 ----
async function doRegister(env, c, opts) {
  if (c.adkey.length < 12) throw new Error("缺少有效 adkey(自动发现密钥, ≥12 位)");
  const want = opts.countries || COUNTRIES;
  const agents = await loadAgents(env);
  const have = new Set(agents.map((a) => a.country));
  const cap = capacity(env);
  // 免费版按 SHARD_SIZE/CRON_ROUNDS 推算的探针上限, 卡住新建数(付费版 PLAN=paid 不限)
  const room = Math.max(0, cap.maxProbes - agents.length);
  let todo = want.filter((cc) => opts.force || !have.has(cc)).slice(0, opts.limit);
  let capped = 0;
  if (todo.length > room) { capped = todo.length - room; todo = todo.slice(0, room); }
  const added = [], failed = [];
  for (const cc of todo) {
    try {
      const { uuid, token } = await komariRegister(c.server, c.adkey, `globe-${cc}`);
      const p = buildProfile(token, opts.ov);
      await komariRpc(c.server, token, "agent.basicInfo", { info: basicInfo(cc, p) }, "bi");
      agents.push({ country: cc, uuid, token, boot: Math.floor(Date.now() / 1000), p, server: c.server });
      added.push(cc);
    } catch (e) {
      failed.push(`${cc}: ${e.message}`);
    }
  }
  await saveAgents(env, agents);
  const remaining = want.filter((cc) => !new Set(agents.map((a) => a.country)).has(cc)).length;
  return { added, failed, total: agents.length, remaining, capped, maxProbes: cap.maxProbes };
}

// 手动模式: 直接用你从 komari 拿到的客户端 token(install 命令里 -t 后面那串)。
// 格式: tokens=token1:US,token2:JP,...  不需要 adkey / 不用管理员权限。
async function doSetup(env, c, pairs, opts = {}) {
  const agents = await loadAgents(env);
  const byTok = new Map(agents.map((a) => [a.token, a]));
  const cap = capacity(env);
  const added = [], failed = [];
  let capped = 0;
  for (const { token, country } of pairs) {
    // 已存在的 token 是覆盖更新, 不占新名额; 只有新增 token 受上限约束
    if (!byTok.has(token) && byTok.size >= cap.maxProbes) { capped++; continue; }
    try {
      const p = buildProfile(token, opts.ov);
      await komariRpc(c.server, token, "agent.basicInfo", { info: basicInfo(country, p) }, "bi");
      const a = { country, token, boot: Math.floor(Date.now() / 1000), p, server: c.server };
      byTok.set(token, a);
      added.push(country);
    } catch (e) {
      failed.push(`${country}: ${e.message}`);
    }
  }
  await saveAgents(env, [...byTok.values()]);
  return { added, failed, total: byTok.size, capped, maxProbes: cap.maxProbes };
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
      await komariRpc(a.server || c.server, a.token, "agent.basicInfo", { info: basicInfo(a.country, p) }, `rp${Date.now()}-${i}`);
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
      return komariRpc(a.server || c.server, a.token, "agent.report",
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

// 内联单页控制台(纯 HTML+JS + Lucide 图标 + 粒子网络背景, 无构建)。浏览器打开首页即可可视化操作。
const UI = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>KOMARI · LIGHT UP THE GLOBE</title>
<link rel="icon" type="image/png" href="data:image/png;base64,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">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<script src="https://unpkg.com/lucide@latest"></script>
<style>
:root{--bg:#080810;--card:rgba(18,18,28,0.55);--line:rgba(255,255,255,0.08);--line-strong:rgba(255,255,255,0.22);--fg:#f5f5f7;--mut:#6b6b80;--acc:#00E5FF;--acc2:#a97bff;--ok:#00ff88;--err:#ff3366}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--fg);font:14px/1.6 'Inter',system-ui,sans-serif;overflow-x:hidden}
canvas#bg{position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;opacity:.55}
.grain{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.04;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.app{max-width:1200px;margin:0 auto;padding:48px 60px 120px}
header{margin-bottom:20px;position:relative;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:24px}
.eyebrow{display:flex;align-items:center;gap:10px;color:var(--mut);font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.35em;text-transform:uppercase;margin-bottom:18px}
.eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 12px var(--ok);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
h1.title{font-family:'Syne',sans-serif;font-size:clamp(48px,8vw,104px);font-weight:800;line-height:.9;letter-spacing:-.04em;text-transform:uppercase;color:#f5f5f7}
h1.title .l2{display:block;font-family:'JetBrains Mono',monospace;font-size:clamp(11px,1.3vw,14px);font-weight:400;letter-spacing:.42em;margin-top:16px;color:var(--mut);text-transform:uppercase}
.cntbar{text-align:right;font-family:'JetBrains Mono',monospace}
.cntbar .n{font-family:'Syne',sans-serif;font-size:clamp(36px,4.5vw,56px);font-weight:800;line-height:1;background:linear-gradient(120deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.cntbar .lbl{font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:var(--mut);margin-top:6px}
.hright{display:flex;flex-direction:column;align-items:flex-end;gap:16px;padding-bottom:4px}
.keybar{display:flex;align-items:center;gap:10px;border:1px solid var(--line);padding:9px 14px;background:rgba(255,255,255,.02);min-width:240px;transition:border-color .3s}
.keybar:focus-within{border-color:var(--acc)}
.keybar i{color:var(--mut);width:15px;height:15px;flex-shrink:0}
.keybar input{border:0;padding:0;font-family:'JetBrains Mono',monospace;font-size:12px;background:transparent;color:var(--fg)}
nav.tabs{display:flex;flex-wrap:wrap;gap:4px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:6px 0;margin-bottom:36px}
.tab{display:flex;align-items:center;gap:10px;padding:12px 22px;background:transparent;border:0;color:var(--mut);font-size:13px;font-weight:500;letter-spacing:.04em;cursor:pointer;transition:all .4s cubic-bezier(.16,1,.3,1);position:relative}
.tab::after{content:'';position:absolute;left:22px;right:22px;bottom:4px;height:2px;background:var(--acc);transform:scaleX(0);transform-origin:left;transition:transform .4s cubic-bezier(.16,1,.3,1)}
.tab:hover{color:var(--fg)}
.tab.on{color:var(--fg)}
.tab.on::after{transform:scaleX(1)}
.tab.on i{color:var(--acc)}
.tab i{width:17px;height:17px;flex-shrink:0}
.pane{display:none}
.pane.active{display:block;animation:rise .7s cubic-bezier(.16,1,.3,1)}
@keyframes rise{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:translateY(0)}}
.card{background:var(--card);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid var(--line);border-radius:2px;padding:44px;margin-bottom:28px;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--line-strong),transparent)}
.card h2{font-family:'Syne',sans-serif;font-size:30px;font-weight:700;letter-spacing:-.02em;margin-bottom:6px;display:flex;align-items:center;gap:14px}
.card h2 i{width:22px;height:22px;color:var(--acc)}
.card .desc{color:var(--mut);margin-bottom:34px;font-size:13px;letter-spacing:.01em}
label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--mut);margin:22px 0 7px}
input,select{width:100%;padding:11px 0;background:transparent;border:0;border-bottom:1px solid var(--line-strong);color:var(--fg);font-family:'Inter',sans-serif;font-size:15px;transition:border-color .3s}
input:focus,select:focus{outline:0;border-bottom-color:var(--acc)}
input::placeholder{color:#3a3a48}
select option{background:#111}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:28px}
.g4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:28px}
.chk{display:flex;align-items:center;gap:9px;margin-top:26px;font-size:13px;color:var(--mut)}
.chk input{width:16px;height:16px;accent-color:var(--acc)}
.btn{cursor:pointer;border:1px solid var(--fg);background:transparent;color:var(--fg);padding:15px 30px;font-family:'Syne',sans-serif;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;transition:all .3s;display:inline-flex;align-items:center;gap:9px;margin:26px 18px 0 0}
.btn:hover{background:var(--fg);color:var(--bg);transform:translateY(-2px)}
.btn i{width:14px;height:14px}
.btn.ghost{border-color:var(--line-strong);color:var(--mut)}
.btn.ghost:hover{border-color:var(--acc);color:var(--acc);background:transparent}
.btn.danger{border-color:rgba(255,51,102,.5);color:var(--err)}
.btn.danger:hover{background:var(--err);color:#fff}
pre#out{background:rgba(0,0,0,.5);border:1px solid var(--line);border-left:2px solid var(--acc);padding:22px 24px;white-space:pre-wrap;word-break:break-all;min-height:70px;margin-top:44px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.85;color:var(--ok);max-height:380px;overflow-y:auto}
.nodes{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:22px}
.node{border:1px solid var(--line);padding:14px;background:rgba(255,255,255,.02);transition:all .3s cubic-bezier(.16,1,.3,1);position:relative}
.node:hover{border-color:var(--acc);transform:translateY(-3px);background:rgba(0,229,255,.04)}
.node .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.cc{font-family:'Syne',sans-serif;font-size:20px;font-weight:800;letter-spacing:-.02em;line-height:1;display:flex;align-items:center;gap:7px}
.cc .fl{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.cc .fl.on{background:var(--ok);box-shadow:0 0 8px var(--ok)}.cc .fl.off{background:var(--err)}.cc .fl.na{background:var(--mut)}
.node .del{cursor:pointer;background:0;border:0;color:#3a3a48;padding:2px;transition:color .2s}
.node .del:hover{color:var(--err)}
.node .badge{display:inline-block;padding:2px 7px;border:1px solid var(--line);border-radius:20px;font-size:9px;letter-spacing:.04em;color:var(--mut);margin:0 0 8px;font-family:'JetBrains Mono',monospace}
.node .meta{font-size:11px;color:var(--mut);line-height:1.7}
.node .meta .mono{font-family:'JetBrains Mono',monospace;font-size:10px;color:#8a8aa0;word-break:break-all}
.badge{display:inline-block;padding:3px 9px;border:1px solid var(--line-strong);border-radius:20px;font-size:10px;letter-spacing:.06em;color:var(--mut);margin:6px 0 10px;font-family:'JetBrains Mono',monospace}
.sumline{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--mut);letter-spacing:.05em;margin-bottom:4px}
.sumline b{color:var(--ok)}.sumline .o{color:var(--err)}
.table{width:100%;border-collapse:collapse;margin-top:22px;font-size:13px}
.table th{text-align:left;padding:12px 0;border-bottom:1px solid var(--line-strong);color:var(--mut);text-transform:uppercase;font-size:10px;letter-spacing:.12em}
.table td{padding:14px 0;border-bottom:1px solid var(--line);vertical-align:top}
.table .mono{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--acc)}
hr{border:0;border-top:1px solid var(--line);margin:34px 0}
.empty{text-align:center;padding:48px;color:var(--mut);font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.1em}
a{color:var(--acc);text-decoration:none}
.modal{display:none;position:fixed;inset:0;z-index:50;background:rgba(4,4,10,.75);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);align-items:center;justify-content:center;padding:24px}
.modal.open{display:flex;animation:fade .3s}
@keyframes fade{from{opacity:0}to{opacity:1}}
.modal-box{background:#0d0d16;border:1px solid var(--line-strong);width:100%;max-width:880px;max-height:86vh;display:flex;flex-direction:column;padding:32px;animation:rise .5s cubic-bezier(.16,1,.3,1)}
.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.modal-head h2{font-family:'Syne',sans-serif;font-size:24px;font-weight:700;display:flex;align-items:center;gap:10px}
.modal-head h2 i{width:20px;height:20px;color:var(--acc)}
#pk-search{margin-bottom:18px}
.pk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;overflow-y:auto;padding:4px 4px 4px 0;flex:1}
.pk{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--line);cursor:pointer;transition:all .2s;user-select:none}
.pk:hover{border-color:var(--line-strong);background:rgba(255,255,255,.03)}
.pk.sel{border-color:var(--acc);background:rgba(0,229,255,.08)}
.pk .code{font-family:'Syne',sans-serif;font-size:16px;font-weight:800;letter-spacing:-.02em;min-width:26px}
.pk .nm{font-size:12px;color:var(--mut);line-height:1.2}
.pk.sel .nm{color:var(--fg)}
.modal-foot{display:flex;justify-content:space-between;align-items:center;margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}
@media(max-width:900px){header{flex-direction:column;align-items:flex-start}.hright{align-items:flex-start;width:100%}.keybar{width:100%}nav.tabs{overflow-x:auto;flex-wrap:nowrap}.tab{padding:12px 14px;white-space:nowrap}.app{padding:28px 20px 80px}.cntbar{text-align:left}.g2,.g3,.g4{grid-template-columns:1fr}}
</style></head>
<body>
<canvas id="bg"></canvas><div class="grain"></div>
<div class="app">
  <header>
    <div>
      <div class="eyebrow"><span class="dot"></span> KOMARI CONTROL DECK · LUTW</div>
      <h1 class="title">KOMARI<span class="l2">Light Up The Globe · 分布式虚拟节点编排控制台</span></h1>
    </div>
    <div class="hright">
      <div class="cntbar"><div class="n" id="cnt">0</div><div class="lbl">Active Nodes</div></div>
      <div class="keybar"><i data-lucide="key-round"></i><input id="key" placeholder="ACCESS_KEY" autocomplete="off"></div>
    </div>
  </header>
  <nav class="tabs">
    <button class="tab on" data-t="reg"><i data-lucide="globe-2"></i> 注册探针</button>
    <button class="tab" data-t="setup"><i data-lucide="link-2"></i> Token 接入</button>
    <button class="tab" data-t="list"><i data-lucide="layout-grid"></i> 节点列表</button>
    <button class="tab" data-t="ops"><i data-lucide="activity"></i> 保活运维</button>
    <button class="tab" data-t="help"><i data-lucide="book-open"></i> 帮助文档</button>
  </nav>
  <div class="content">
      <div class="card pane active" id="p-reg">
        <h2><i data-lucide="globe-2"></i> 自动注册</h2>
        <p class="desc">使用自动发现密钥，在目标面板批量生成整机画像一致的虚拟节点。</p>
        <label>国家代码（逗号分隔；留空匹配全部 ~200 个；可重复多开）</label>
        <input id="countries" placeholder="US,JP,DE,GB,FR,AQ">
        <button class="btn ghost" onclick="openPicker()" style="margin-top:12px"><i data-lucide="mouse-pointer-click"></i> 可视化挑选国家</button>
        <div class="g4">
          <div><label>机器模板组</label><select id="group"><option value="">自动分配</option><option value="budget-x86">廉价 x86 VPS</option><option value="modern-intel">现代 Intel</option><option value="modern-amd">现代 AMD EPYC</option><option value="aws-x86">AWS x86</option><option value="aws-arm">AWS Graviton</option><option value="gcp-x86">GCP x86</option><option value="gcp-arm">GCP ARM</option><option value="azure-x86">Azure x86</option><option value="azure-arm">Azure ARM</option><option value="oci-arm">Oracle ARM</option><option value="enterprise-vmware">企业 VMware</option><option value="dedicated-x86">独服/家用机</option></select></div>
          <div><label>IP 模式</label><select id="ipmode"><option value="">默认 v4</option><option>v4</option><option>v6</option><option>both</option><option>mix</option></select></div>
          <div><label>本次数量 limit</label><input id="limit" placeholder="20"></div>
          <div><label>固定 IPv4</label><input id="ip4" placeholder="随机"></div>
        </div>
        <div class="g4">
          <div><label>核数 cores</label><input id="cores" placeholder="随机"></div>
          <div><label>物理核 pcores</label><input id="pcores" placeholder="随机"></div>
          <div><label>内存 GB</label><input id="mem" placeholder="随机"></div>
          <div><label>磁盘 GB</label><input id="disk" placeholder="随机"></div>
        </div>
        <div class="g4">
          <div><label>交换 GB</label><input id="swap" placeholder="随机"></div>
          <div><label>下行 KB/s</label><input id="downrate" placeholder="随机"></div>
          <div><label>上行 KB/s</label><input id="uprate" placeholder="随机"></div>
          <div><label>固定 IPv6</label><input id="ip6" placeholder="随机"></div>
        </div>
        <div class="g3">
          <div><label>CPU 型号</label><input id="cpu" placeholder="随机"></div>
          <div><label>系统 OS</label><input id="os" placeholder="随机"></div>
          <div><label>虚拟化 Virt</label><input id="virt" placeholder="随机"></div>
        </div>
        <div class="g3">
          <div><label>架构 Arch</label><input id="arch" placeholder="随机"></div>
          <div><label>GPU</label><input id="gpu" placeholder="随机/空"></div>
          <div><label>内核 Kernel</label><input id="kernel" placeholder="随机"></div>
        </div>
        <label class="chk"><input type="checkbox" id="force"> 允许重复国家 / 覆盖重建（force）</label>
        <div><button class="btn" onclick="reg()"><i data-lucide="plus-circle"></i> 注册</button>
        <button class="btn ghost" onclick="regAll()"><i data-lucide="zap"></i> 一键注册全部</button></div>
      </div>
      <div class="card pane" id="p-setup">
        <h2><i data-lucide="link-2"></i> 手动接入</h2>
        <p class="desc">无需管理员权限，直接用客户端 Token 接入指定国家；可套用注册页的配置项。</p>
        <div style="border:1px solid var(--line);border-left:2px solid var(--acc);padding:14px 18px;margin-bottom:8px;font-size:12px;color:var(--mut);line-height:1.8">
          <b style="color:var(--fg)">Token 从哪来？</b> 面板“添加服务器”给出的一键安装命令里，<code class="mono" style="color:var(--acc)">-t</code> 后面那串就是。<br>
          例：<span class="mono">wget … | sudo bash -s -- -e https://komari.example.com -t </span><span class="mono" style="color:var(--acc)">AYhew*********UJzU3</span><br>
          把它填成 <span class="mono">YOUR TOKEN:US</span>（冒号后是国家代码），多个用逗号分隔。
        </div>
        <label>面板地址（可选，留空用默认 KOMARI_SERVER；填了则接入到该面板）</label>
        <input id="s_server" placeholder="https://komari.example.com">
        <label>Tokens（格式 token:US,token2:JP，冒号后为国家代码）</label>
        <input id="tokens" placeholder="YOUR TOKEN:US,abcd1234:JP">
        <div><button class="btn" onclick="setup()"><i data-lucide="log-in"></i> 接入</button></div>
      </div>
      <div class="card pane" id="p-list">
        <h2><i data-lucide="layout-grid"></i> 节点列表 <button class="btn ghost" onclick="loadList()" style="margin:0 0 0 auto;padding:9px 18px;font-size:11px"><i data-lucide="refresh-cw"></i> 刷新</button></h2>
        <div id="tbl"><div class="empty">POINT &amp; CLICK REFRESH TO LOAD NODES</div></div>
      </div>
      <div class="card pane" id="p-ops">
        <h2><i data-lucide="activity"></i> 保活与运维</h2>
        <div class="g3">
          <div><label>Rounds 轮数</label><input id="d_rounds" placeholder="1"></div>
          <div><label>Gap 间隔秒</label><input id="d_gap" placeholder="0"></div>
          <div style="display:flex;align-items:flex-end"><button class="btn" onclick="drive()"><i data-lucide="rocket"></i> 扇出保活</button></div>
        </div>
        <button class="btn ghost" onclick="go('/status')"><i data-lucide="info"></i> 查看状态</button>
        <button class="btn ghost" onclick="go('/report')"><i data-lucide="server"></i> 直连保活</button>
        <hr>
        <h2 style="font-size:22px"><i data-lucide="layers"></i> 重建画像</h2>
        <p class="desc">旧 KV 中的配置不会自动更新；每批最多 40 台，按 offset 分批重建并推送到面板。</p>
        <div class="g3">
          <div><label>Offset 起始</label><input id="rp_offset" placeholder="0"></div>
          <div><label>Limit 每批≤40</label><input id="rp_limit" placeholder="40"></div>
          <div style="display:flex;align-items:flex-end"><button class="btn" onclick="reprofile()"><i data-lucide="refresh-ccw-dot"></i> 重建批次</button></div>
        </div>
        <hr>
        <h2 style="font-size:22px"><i data-lucide="trash-2"></i> 移除管理</h2>
        <label>按国家移除（逗号分隔；仅从 KV 移除，面板仍需手动删）</label>
        <input id="rmc" placeholder="US,JP">
        <div><button class="btn danger" onclick="rm()"><i data-lucide="x-circle"></i> 移除</button>
        <button class="btn danger" onclick="if(confirm('确认清空全部 KV 记录? 面板探针不受影响'))go('/reset')"><i data-lucide="alert-triangle"></i> 清空全部</button></div>
      </div>
      <div class="card pane" id="p-help">
        <h2><i data-lucide="book-open"></i> 环境与路由</h2>
        <p class="desc">在 Cloudflare 后台 Settings → Variables 配置以启用对应能力。</p>
        <table class="table">
          <tr><th>变量</th><th>作用</th></tr>
          <tr><td class="mono">KOMARI_KV</td><td>KV 绑定（必须，存探针数据）</td></tr>
          <tr><td class="mono">KOMARI_SERVER</td><td>面板地址（必须）</td></tr>
          <tr><td class="mono">KOMARI_ADKEY</td><td>自动发现密钥（走注册需要）</td></tr>
          <tr><td class="mono">ACCESS_KEY</td><td>控制台 / 写操作口令</td></tr>
          <tr><td class="mono">SELF</td><td>Service binding 绑到自身（开扇出，推荐）</td></tr>
          <tr><td class="mono">SELF_URL</td><td>本 Worker 地址（无 SELF 绑定时的退路）</td></tr>
          <tr><td class="mono">SHARD_SIZE</td><td>每分片探针数，默认 40</td></tr>
          <tr><td class="mono">CRON_ROUNDS / CRON_GAP</td><td>每分钟上报轮数 / 间隔秒（如 28/2 ≈ 每 2 秒）</td></tr>
          <tr><td class="mono">SPEC_GROUP</td><td>固定模板组；留空按权重稳定分配</td></tr>
          <tr><td class="mono">SPEC_*</td><td>画像覆盖：SPEC_CPU/CORES/MEM/DISK/OS/IPMODE/UPRATE…</td></tr>
        </table>
        <p style="margin-top:22px;font-size:12px;color:var(--mut)">路由：/register /setup /reprofile /report /drive /status /list /remove /reset · 开源 <a href="https://github.com/TyrEamon/komari-LUTW" target="_blank">TyrEamon/komari-LUTW</a></p>
      </div>
      <pre id="out">SYSTEM READY.</pre>
  </div>
</div>
<div class="modal" id="picker">
  <div class="modal-box">
    <div class="modal-head"><h2><i data-lucide="flag"></i> 挑选国家 / 地区</h2><button class="del" onclick="closePicker()"><i data-lucide="x"></i></button></div>
    <input id="pk-search" placeholder="搜索国家名 / 代码，如 日本 / JP / Japan" oninput="renderPicker()">
    <div class="pk-grid" id="pk-grid"></div>
    <div class="modal-foot"><span id="pk-count" class="sumline">已选 0 个</span><div><button class="btn ghost" onclick="closePicker()"><i data-lucide="x-circle"></i> 取消</button><button class="btn" onclick="applyPicker()"><i data-lucide="check"></i> 确认添加</button></div></div>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);
$('key').value=localStorage.getItem('k')||'';
$('key').oninput=e=>localStorage.setItem('k',e.target.value);
const out=$('out');
function icons(){if(window.lucide)lucide.createIcons();}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));t.classList.add('on');
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));
  $('p-'+t.dataset.t).classList.add('active');
  if(t.dataset.t==='list')loadList();
  icons();
});
function qs(o){const p=[];for(const k in o){const v=o[k];if(v!==''&&v!=null)p.push(k+'='+encodeURIComponent(v))}const kk=$('key').value.trim();if(kk)p.push('key='+encodeURIComponent(kk));return p.length?'?'+p.join('&'):''}
async function call(path){out.textContent='REQUESTING…';try{const r=await fetch(path);const t=await r.text();out.textContent=t;refresh()}catch(e){out.textContent='ERROR: '+e}}
function go(p){const kk=$('key').value.trim();call(p+(p.includes('?')?'&':'?')+(kk?'key='+encodeURIComponent(kk):''))}
function spec(){return{group:$('group').value,ipmode:$('ipmode').value,cores:$('cores').value.trim(),pcores:$('pcores').value.trim(),mem:$('mem').value.trim(),disk:$('disk').value.trim(),swap:$('swap').value.trim(),downrate:$('downrate').value.trim(),uprate:$('uprate').value.trim(),cpu:$('cpu').value.trim(),os:$('os').value.trim(),virt:$('virt').value.trim(),arch:$('arch').value.trim(),gpu:$('gpu').value.trim(),kernel:$('kernel').value.trim(),ip4:$('ip4').value.trim(),ip6:$('ip6').value.trim()}}
function reg(){call('/register'+qs(Object.assign({countries:$('countries').value.trim(),limit:$('limit').value.trim(),force:$('force').checked?'1':''},spec())))}
function regAll(){if(confirm('注册内置全部 ~200 个国家? 会分批, 多点几次直到全部完成'))call('/register'+qs(Object.assign({limit:'40',force:$('force').checked?'1':''},spec())))}
function setup(){call('/setup'+qs(Object.assign({tokens:$('tokens').value.trim(),server:$('s_server').value.trim()},spec())))}
function drive(){go('/drive?rounds='+($('d_rounds').value.trim()||'1')+'&gap='+($('d_gap').value.trim()||'0'))}
function reprofile(){call('/reprofile'+qs(Object.assign({offset:$('rp_offset').value.trim()||'0',limit:$('rp_limit').value.trim()||'40'},spec())))}
function rm(){const c=$('rmc').value.trim();if(!c)return;if(confirm('从 KV 移除 '+c+' ?'))call('/remove'+qs({countries:c}))}
function fmtB(b){b=+b;return b>=1073741824?(b/1073741824).toFixed(0)+'G':b?(b/1048576).toFixed(0)+'M':'-'}
async function loadList(){const box=$('tbl');box.innerHTML='<div class="empty">LOADING NODES…</div>';try{const r=await fetch('/list');const j=await r.json();
  if(!j.count){box.innerHTML='<div class="empty">NO NODES YET — REGISTER SOME FIRST</div>';return}
  const on=j.agents.filter(a=>a.online===true).length;
  let h='<div class="sumline">TOTAL '+j.count+(j.onlineKnown?' · ONLINE <b>'+on+'</b> · OFFLINE <span class="o">'+(j.count-on)+'</span>':' · 面板在线态不可用')+'</div><div class="nodes">';
  for(const a of j.agents){const ip=a.ipMode==='v6'?a.ip6:(a.ipMode==='both'?a.ip4+' / v6':a.ip4);
    const sc=a.online===true?'on':(a.online===false?'off':'na');
    h+='<div class="node"><div class="top"><div class="cc"><span class="fl '+sc+'"></span>'+a.country+'</div><button class="del" title="移除" onclick="rmTok(\\''+a.token+'\\',\\''+a.country+'\\')"><i data-lucide="trash-2"></i></button></div><span class="badge">'+(a.profileLabel||a.profileGroup||'—')+'</span><div class="meta"><span class="mono">'+ip+'</span><br>'+a.cores+' vCPU · '+fmtB(a.mem)+' · '+fmtB(a.disk)+'<br>'+(a.os||'—')+'</div></div>'}
  h+='</div>';box.innerHTML=h;icons();}catch(e){box.innerHTML='<div class="empty">LOAD FAILED: '+e+'</div>'}}
function rmTok(tok,cc){if(!confirm('移除 '+cc+' 这一台?'))return;call('/remove'+qs({tokens:tok})).then(loadList)}
// —— 国家可视化挑选器 ——
const CN_NAMES={AD:"安道尔",AE:"阿联酋",AF:"阿富汗",AG:"安提瓜和巴布达",AL:"阿尔巴尼亚",AM:"亚美尼亚",AO:"安哥拉",AR:"阿根廷",AT:"奥地利",AU:"澳大利亚",AW:"阿鲁巴",AZ:"阿塞拜疆",AQ:"南极洲",BA:"波黑",BB:"巴巴多斯",BD:"孟加拉国",BE:"比利时",BF:"布基纳法索",BG:"保加利亚",BH:"巴林",BI:"布隆迪",BJ:"贝宁",BN:"文莱",BO:"玻利维亚",BR:"巴西",BS:"巴哈马",BT:"不丹",BW:"博茨瓦纳",BY:"白俄罗斯",BZ:"伯利兹",CA:"加拿大",CD:"刚果(金)",CF:"中非",CG:"刚果(布)",CH:"瑞士",CI:"科特迪瓦",CL:"智利",CM:"喀麦隆",CN:"中国",CO:"哥伦比亚",CR:"哥斯达黎加",CU:"古巴",CV:"佛得角",CY:"塞浦路斯",CZ:"捷克",DE:"德国",DJ:"吉布提",DK:"丹麦",DM:"多米尼克",DO:"多米尼加",DZ:"阿尔及利亚",EC:"厄瓜多尔",EE:"爱沙尼亚",EG:"埃及",ER:"厄立特里亚",ES:"西班牙",ET:"埃塞俄比亚",FI:"芬兰",FJ:"斐济",FM:"密克罗尼西亚",FR:"法国",GA:"加蓬",GB:"英国",GD:"格林纳达",GE:"格鲁吉亚",GH:"加纳",GL:"格陵兰",GM:"冈比亚",GN:"几内亚",GQ:"赤道几内亚",GR:"希腊",GT:"危地马拉",GW:"几内亚比绍",GY:"圭亚那",HK:"中国香港",HN:"洪都拉斯",HR:"克罗地亚",HT:"海地",HU:"匈牙利",ID:"印度尼西亚",IE:"爱尔兰",IL:"以色列",IN:"印度",IQ:"伊拉克",IR:"伊朗",IS:"冰岛",IT:"意大利",JM:"牙买加",JO:"约旦",JP:"日本",KE:"肯尼亚",KG:"吉尔吉斯斯坦",KH:"柬埔寨",KI:"基里巴斯",KM:"科摩罗",KN:"圣基茨和尼维斯",KP:"朝鲜",KR:"韩国",KW:"科威特",KZ:"哈萨克斯坦",LA:"老挝",LB:"黎巴嫩",LC:"圣卢西亚",LI:"列支敦士登",LK:"斯里兰卡",LR:"利比里亚",LS:"莱索托",LT:"立陶宛",LU:"卢森堡",LV:"拉脱维亚",LY:"利比亚",MA:"摩洛哥",MC:"摩纳哥",MD:"摩尔多瓦",ME:"黑山",MG:"马达加斯加",MH:"马绍尔群岛",MK:"北马其顿",ML:"马里",MM:"缅甸",MN:"蒙古",MO:"中国澳门",MR:"毛里塔尼亚",MT:"马耳他",MU:"毛里求斯",MV:"马尔代夫",MW:"马拉维",MX:"墨西哥",MY:"马来西亚",MZ:"莫桑比克",NA:"纳米比亚",NE:"尼日尔",NG:"尼日利亚",NI:"尼加拉瓜",NL:"荷兰",NO:"挪威",NP:"尼泊尔",NR:"瑙鲁",NZ:"新西兰",OM:"阿曼",PA:"巴拿马",PE:"秘鲁",PG:"巴布亚新几内亚",PH:"菲律宾",PK:"巴基斯坦",PL:"波兰",PR:"波多黎各",PS:"巴勒斯坦",PT:"葡萄牙",PW:"帕劳",PY:"巴拉圭",QA:"卡塔尔",RO:"罗马尼亚",RS:"塞尔维亚",RU:"俄罗斯",RW:"卢旺达",SA:"沙特阿拉伯",SB:"所罗门群岛",SC:"塞舌尔",SD:"苏丹",SE:"瑞典",SG:"新加坡",SI:"斯洛文尼亚",SK:"斯洛伐克",SL:"塞拉利昂",SM:"圣马力诺",SN:"塞内加尔",SO:"索马里",SR:"苏里南",SS:"南苏丹",ST:"圣多美和普林西比",SV:"萨尔瓦多",SY:"叙利亚",SZ:"斯威士兰",TD:"乍得",TG:"多哥",TH:"泰国",TJ:"塔吉克斯坦",TL:"东帝汶",TM:"土库曼斯坦",TN:"突尼斯",TO:"汤加",TR:"土耳其",TT:"特立尼达和多巴哥",TV:"图瓦卢",TW:"中国台湾",TZ:"坦桑尼亚",UA:"乌克兰",UG:"乌干达",US:"美国",UY:"乌拉圭",UZ:"乌兹别克斯坦",VA:"梵蒂冈",VC:"圣文森特和格林纳丁斯",VE:"委内瑞拉",VN:"越南",VU:"瓦努阿图",WS:"萨摩亚",YE:"也门",ZA:"南非",ZM:"赞比亚",ZW:"津巴布韦"};
const ALL_CC=Object.keys(CN_NAMES);
let pkSel=new Set();
function openPicker(){pkSel=new Set(($('countries').value||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean));$('pk-search').value='';renderPicker();$('picker').classList.add('open');icons()}
function closePicker(){$('picker').classList.remove('open')}
function renderPicker(){const q=$('pk-search').value.trim().toLowerCase();const grid=$('pk-grid');let h='';
  for(const cc of ALL_CC){const nm=CN_NAMES[cc];if(q&&!(cc.toLowerCase().includes(q)||nm.includes(q)))continue;
    h+='<div class="pk'+(pkSel.has(cc)?' sel':'')+'" onclick="togglePk(\\''+cc+'\\')"><span class="code">'+cc+'</span><span class="nm">'+nm+'</span></div>'}
  grid.innerHTML=h||'<div class="empty">无匹配</div>';$('pk-count').textContent='已选 '+pkSel.size+' 个'}
function togglePk(cc){pkSel.has(cc)?pkSel.delete(cc):pkSel.add(cc);renderPicker()}
function applyPicker(){$('countries').value=[...pkSel].join(',');closePicker()}
async function refresh(){try{const r=await fetch('/list');const j=await r.json();animateCount(j.count||0)}catch(e){}}
let _cv=0;function animateCount(to){const from=_cv,d=600,t0=performance.now();function step(t){const k=Math.min(1,(t-t0)/d);const e=1-Math.pow(1-k,3);$('cnt').textContent=Math.round(from+(to-from)*e);if(k<1)requestAnimationFrame(step)}requestAnimationFrame(step);_cv=to}
refresh();icons();

// —— 交互式粒子网络背景 ——
const cv=$('bg'),cx=cv.getContext('2d');let W,H,ns=[],mx=-1e3,my=-1e3;
function rz(){W=cv.width=innerWidth;H=cv.height=innerHeight;ns=[];const c=Math.min(120,Math.floor(W*H/24000));for(let i=0;i<c;i++)ns.push({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.28,vy:(Math.random()-.5)*.28,r:Math.random()*1.4+.4})}
function draw(){cx.clearRect(0,0,W,H);for(let i=0;i<ns.length;i++){const n=ns[i];n.x+=n.vx;n.y+=n.vy;if(n.x<0||n.x>W)n.vx*=-1;if(n.y<0||n.y>H)n.vy*=-1;
  const dx=mx-n.x,dy=my-n.y,dm=Math.hypot(dx,dy);if(dm<200){cx.beginPath();cx.moveTo(n.x,n.y);cx.lineTo(mx,my);cx.strokeStyle='rgba(0,229,255,'+(1-dm/200)*.45+')';cx.lineWidth=1;cx.stroke()}
  cx.beginPath();cx.arc(n.x,n.y,n.r,0,7);cx.fillStyle='rgba(245,245,247,.9)';cx.fill();
  for(let j=i+1;j<ns.length;j++){const m=ns[j],ddx=n.x-m.x,ddy=n.y-m.y,d2=Math.hypot(ddx,ddy);if(d2<130){cx.beginPath();cx.moveTo(n.x,n.y);cx.lineTo(m.x,m.y);cx.strokeStyle='rgba(150,160,220,'+(1-d2/130)*.09+')';cx.lineWidth=1;cx.stroke()}}}
  requestAnimationFrame(draw)}
addEventListener('resize',rz);addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY});addEventListener('mouseout',()=>{mx=my=-1e3});
rz();draw();
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
        (r.capped ? `\n⚠️ 已达免费版容量上限 ${r.maxProbes} 个, 本次有 ${r.capped} 个被拒。调大 SHARD_SIZE/降低 CRON_ROUNDS 或换账号, 详见 /status` : "") +
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
        `KV 内合计: ${r.total}` +
        (r.capped ? `\n⚠️ 已达免费版容量上限 ${r.maxProbes} 个, 有 ${r.capped} 个被拒（覆盖已有 token 不占名额）` : "") +
        (r.failed.length ? `\n失败:\n` + r.failed.join("\n") : ""));
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
      const cap = capacity(env);
      const capLine = cap.paid
        ? `\n\n容量: 付费版(PLAN=paid), 探针数不限。`
        : `\n\n免费版容量: 上限约 ${cap.maxProbes} 个（当前 ${agents.length}）
  依据 SHARD_SIZE=${cap.effShard} × 最多 ${cap.maxShards} 分片 | CRON_ROUNDS=${cap.rounds}, CRON_GAP=${cap.gap}s${cap.gapOk ? "" : " ⚠️ ROUNDS×GAP>55s, 每分钟跑不完, 请调小"}
  想挂更多: 调大 SHARD_SIZE(≤45) / 调小 CRON_ROUNDS, 或多开免费账号(每账号一份额度)。`;
      return txt(`已注册 ${agents.length} 个探针:
` + agents.map((a) => a.country + flagEmoji(a.country)).join(" ") +
        (groups ? `

模板分布:
${groups}` : "") + capLine);
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


