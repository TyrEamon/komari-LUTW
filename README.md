# komari-LUTW · 点亮全球

用 Cloudflare Worker 给 [Komari](https://github.com/komari-monitor/komari) 面板批量注册"假探针"，
伪装成全球 ~200 个国家/地区，把面板地图点满。

- 直接讲 Komari 的 HTTP JSON-RPC 协议，**不需要 protobuf / 不需要跑官方 agent**。
- 每个探针按 token 生成一套**稳定的真实感配置**（CPU 型号 / 内存 / 磁盘固定，使用率 / 负载 / 流量浮动，累计流量随运行时间增长）。
- `ipv4` 填保留地址 `192.0.2.1`（GeoIP 无法定位）+ 直接塞 `region` 国旗，
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
5. **加定时器**：Settings → Triggers → Cron Triggers → `* * * * *`（每分钟）。代码内部跑 2 轮、隔 30s，盖住 Komari 的 35s 在线判定。



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

其它路由：`/status` 看进度、`/report` 手动保活、`/reset` 清空记录（不删面板上的探针）。

## 自定义配置（可选，不填=每台随机）

加在 `/register` 或 `/setup` 后面，或用 `SPEC_*` 环境变量设全局默认：

| 参数 | 说明 | 例 |
|---|---|---|
| `cpu` | CPU 型号 | `AMD%20EPYC%209654` |
| `cores` / `pcores` | 逻辑核 / 物理核 | `4` |
| `mem` / `swap` / `disk` | 内存 / 交换 / 磁盘（GB） | `8` |
| `arch` `os` `virt` `gpu` `kernel` | 架构/系统/虚拟化/显卡/内核 | `amd64` |

例：`/register?cpu=AMD%20EPYC%209654&cores=4&mem=8&disk=160`

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

- **活值曲线**：CPU/内存/网络等按时间做平滑正弦起伏 + 噪声 + 偶发尖峰，每台探针周期相位都不同，看着不呆板。
- **刷新频率**：默认每 ~30s 上报一次（cron 每分钟 × 2 轮）。想更快就调变量：
  - `CRON_ROUNDS=6`、`CRON_GAP=10` → 约每 10 秒一次
  - 注意 `CRON_ROUNDS × CRON_GAP` 控制在 ~50 秒内（一次 cron 触发的时长上限）；轮数越多，每天请求/读取次数也越多。
- Komari 判在线只需 35s 内有上报，所以更快纯属好看，不是必须。



## 文件

- `worker.js` — Worker / Pages 主程序（把它整段粘进 CF 代码编辑器）
- `komari点亮全球.py` — 本地脚本版（不想上 CF 时用，功能较简单）

仅用于自己的面板做展示，请勿滥用。
