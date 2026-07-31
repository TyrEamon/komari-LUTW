# komari-LUTW · 点亮全球

用 Cloudflare Worker 给 [Komari](https://github.com/komari-monitor/komari) 面板批量注册"假探针"，
伪装成全球 ~200 个国家/地区，把面板地图点满。

- 直接讲 Komari 的 HTTP JSON-RPC 协议，**不需要 protobuf / 不需要跑官方 agent**。
- 每个探针按 token 生成一套**稳定的真实感配置**（CPU 型号 / 内存 / 磁盘 / IP 固定，使用率 / 负载 / 网络自然浮动，累计流量随运行时间增长）。
- IP 默认随机且**不可被 GeoIP 定位**（v4 用 CGNAT `100.64/10`、v6 用 `2001:db8::`），再直接塞 `region` 国旗，
  所以**不用关面板 GeoIP，也不影响你真实的服务器**。

> ⚠️ 这些数字都是编造的，不是真实机器信息，仅用于"点亮地图"这类展示。

## 部署到 Cloudflare（网页后台手动方式）

全程在 Cloudflare 后台点，不用装 node/wrangler：

1. **建 KV**：后台 → Storage & Databases → KV → 新建命名空间（名字随意）。
2. **建 Worker**：Workers & Pages → Create → Workers → 起名 → Deploy（先部署默认的）→ **Edit code**，把本仓库 `worker.js` 全部内容粘进去 → Deploy。
3. **绑 KV**：该 Worker → Settings → Bindings → Add → KV namespace，Variable name 填 **`KOMARI_KV`**（一字不差），选第 1 步的命名空间。
4. **加变量**：Settings → Variables and Secrets：
   - `KOMARI_SERVER` = 你的面板地址（Plaintext）
   - `KOMARI_ADKEY` = 自动发现密钥（Secret，仅 `/register` 需要）
   - `ACCESS_KEY` = 可选口令（Secret，保护 `/register /setup /reset`）
   - `SELF_URL` = 本 Worker 的公开地址（如 `https://xxx.workers.dev`）。**免费版想带 200 个必填**，见下方"免费版"。
   - `SHARD_SIZE` = 每分片探针数（可选，默认 40，免费版 ≤45）
5. **加定时器**：Settings → Triggers → Cron Triggers → `* * * * *`（每分钟）。代码内部按 `CRON_ROUNDS`/`CRON_GAP` 多轮上报，盖住 Komari 的 35s 在线判定。

## 环境变量总览

在 Worker → **Settings → Variables and Secrets** 里设置。

| 变量 | 类型 | 必填 | 作用 |
|---|---|---|---|
| `KOMARI_KV` | **KV 绑定** | ✅ | KV 命名空间绑定（不是普通变量），存探针 uuid/token/画像 |
| `KOMARI_SERVER` | Plaintext | ✅ | 面板地址，如 `https://komari.example.com` |
| `KOMARI_ADKEY` | Secret | 走 /register 时 | 自动发现密钥（≥12 位，面板后台设置里） |
| `ACCESS_KEY` | Secret | 可选 | 保护 `/register /setup /reset`，设了访问要带 `?key=` |
| `SELF_URL` | Plaintext | 高频/多探针 | 本 Worker 公开地址，设了才开「扇出」（绕开单次 50 子请求上限） |
| `SHARD_SIZE` | Plaintext | 可选 | 每分片探针数，默认 40（免费版 ≤45） |
| `CRON_ROUNDS` | Plaintext | 可选 | 每次 cron 触发内部上报轮数，默认 2；越大越频繁 |
| `CRON_GAP` | Plaintext | 可选 | 每轮间隔秒，默认 30；`ROUNDS×GAP≈60` 且 ≤~50 |

**机器画像默认值**（不设=每台随机；设了=所有探针统一用）：
`SPEC_CPU` `SPEC_CORES` `SPEC_PCORES` `SPEC_MEM` `SPEC_SWAP` `SPEC_DISK` `SPEC_ARCH` `SPEC_OS` `SPEC_VIRT` `SPEC_GPU` `SPEC_KERNEL` `SPEC_IP4` `SPEC_IP6` `SPEC_IPMODE`（内存/磁盘/交换单位 GB）。




## 连接（把探针挂上面板）

打开 Worker 地址 `https://<worker>.workers.dev`，二选一：

**A. 你是面板管理员（有自动发现密钥）**
```
/register?key=你的ACCESS_KEY          # 每次建 20 个，刷新到"全部完成"
```
自动发现密钥在 Komari 后台 → 设置 → 常规里的「自动发现密钥」（跟站点名称、API 密钥同一页，需管理员）。

**B. 你只有客户端 token（一键部署命令里 `-t` 后面那串）**
```
/setup?tokens=你的token:US,另一个token:JP,第三个:AQ
```

其它路由：`/status` 看进度、`/report` 手动保活、`/drive` 手动触发一次扇出、`/remove?countries=US,JP` 从 KV 移除指定国家（面板仍需手动删）、`/reset` 清空记录。

### /register 用法与示例

- 一次最多建 `limit` 个（默认 20，防超子请求上限）；国家多了就**多刷几次**同一条链接（幂等，会接着建没建完的）。
- 不带 `countries=` 就注册内置的 ~200 个国家；带了就只建列出的。
- 没设 `ACCESS_KEY` 就去掉 `&key=...`。

```bash
# 全部 ~200 个国家(各一个), 刷到"全部完成"
/register?key=你的口令

# 只挑几个国家
/register?key=你的口令&countries=US,JP,DE,GB,FR,AQ

# 挑国家 + 指定配置(所有新建的都用这套)
/register?key=你的口令&countries=US,JP&cpu=AMD%20EPYC%209654&cores=4&mem=8&ipmode=both
```

### 重复国家（同一国家挂多个）

默认 `/register` 幂等——已建过的国家会跳过。想故意开重复（比如 3 个都挂美国），加 **`&force=1`**，
并可在 `countries=` 里把同一国家写多次：

```bash
# 3 个美国 + 2 个香港(各自独立 token, 画像/IP 各不相同, 不穿帮)
/register?key=你的口令&countries=US,US,US,HK,HK&force=1

# 或反复调这条, 每调一次就多一个美国
/register?key=你的口令&countries=US&force=1
```


## 自定义配置（可选，不填=每台随机）

加在 `/register` 或 `/setup` 后面，或用 `SPEC_*` 环境变量设全局默认：

| 参数 | 说明 | 例 |
|---|---|---|
| `cpu` | CPU 型号 | `AMD%20EPYC%209654` |
| `cores` / `pcores` | 逻辑核 / 物理核 | `4` |
| `mem` / `swap` / `disk` | 内存 / 交换 / 磁盘（GB） | `8` |
| `uprate` / `downrate` | 平均上行/下行速率（KB/s，不填=随机 ~KB级） | `500` |
| `arch` `os` `virt` `gpu` `kernel` | 架构/系统/虚拟化/显卡/内核 | `amd64` |
| `ipmode` | IP 类型：`v4` / `v6` / `both` / `mix`（默认 v4） | `mix` |
| `ip4` / `ip6` | 固定某个 IP（默认每台随机） | `203.0.113.9` |

例：`/register?cpu=AMD%20EPYC%209654&cores=4&mem=8&disk=160`

> IP 默认**随机、且不可被 GeoIP 定位**（v4 用 CGNAT `100.64/10`，v6 用文档段 `2001:db8::`），
> 这样国旗不会被 GeoIP 覆盖。想要真实公网 IP 会与国旗冲突（GeoIP 会按 IP 改国家），故默认不这么做。


## ⚠️ 免费版也能带 200 个（自调度扇出）

Cloudflare 免费版**每次调用最多 50 个子请求**，一次性保活 200 个探针会超。
解决办法：**设 `SELF_URL` 后走"扇出"模式** —— cron 触发时，主调用只发几个子请求到自己的
`/report` 分片（默认每片 40 个探针），而**每个分片是一次独立的 Worker 调用、各自享有独立的
50 子请求额度**。于是 200 个探针 = 5 个分片 × 40，每片 40 < 50，免费版稳稳带得动。

- **设了 `SELF_URL`** → 免费版即可 200 个全在线（无需付费、无需外部机器）。
- **没设 `SELF_URL`** → 退回直接保活，免费版只能 ≤48 个（可用 `?countries=` 限制数量）。
- 付费版（$5/月，1000 子请求）设不设都行。

手动测一次扇出：打开 `/drive`（或 `/drive?shard=40`）。

## 更快 / 更自然

- **活值曲线**：所有指标都随每次上报自然上下波动。网络用最短周期（最灵动），
  CPU/内存/负载用中等周期 + 噪声 + 偶发尖峰 —— 每次上报都看得见变化，但平滑不乱跳，每台探针曲线都不同。
- **刷新频率**：由 cron 每分钟触发、内部多轮上报决定。想更快就调变量：

  | `CRON_ROUNDS` | `CRON_GAP` | 约每 | 备注 |
  |---|---|---|---|
  | 6 | 8 | 8s | 默认够用 |
  | 16 | 3 | 3s | 探针少时推荐 |
  | 25 | 2 | 2s | 探针少 + 设了 SELF_URL 时可行 |

- **关键约束（免费版）**：一次 cron 触发里的子请求有上限（50）。设了 `SELF_URL` 走扇出后，
  主调度每轮只发「分片数」个子请求，所以 **`分片数 × CRON_ROUNDS ≤ 45` 且 `CRON_ROUNDS × CRON_GAP ≤ 50秒`**。
  探针 ≤40 个只有 1 个分片，于是 2~3 秒完全 OK；**1 秒会顶到上限**，不保证稳。
- **错开上报**：一个 worker 保活多个探针时，会按 token 给每个探针一个稳定相位 + 随机抖动，
  把它们的上报**散布在整个间隔内**（不是同一刻齐刷刷上报），所以"最后上报"时间戳各不相同，像各自独立的 agent。
- 探针数越少、拆的账号越多，越能压到更快的频率。Komari 判在线只需 35s 内有上报，更快纯属好看。





## 文件

- `worker.js` — Worker / Pages 主程序（把它整段粘进 CF 代码编辑器）
- `komari点亮全球.py` — 本地脚本版（不想上 CF 时用，功能较简单）

仅用于自己的面板做展示，请勿滥用。
