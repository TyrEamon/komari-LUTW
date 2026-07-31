/**
 * driver-worker.js —— 独立「驱动」worker（方案 B）
 * =================================================
 * 用途: 当主 worker 无法通过自身 workers.dev 地址扇出(CF 会 404)、又不想用
 *       Service Binding 时, 部署这个第二个 worker 来「从外部」高频驱动主 worker 的 /report。
 *       跨 worker 请求是正常公网入站, 不会 404。
 *
 * 部署(同一个 CF 账号再建一个 worker 即可, 不需要域名/另一个号):
 *   1. 新建 worker, 把本文件全部内容粘进去 → Deploy
 *   2. Settings → Variables and Secrets 加:
 *        TARGET = 主 worker 地址, 如 https://us.kitty-f21.workers.dev   (Plaintext, 必填)
 *        ROUNDS = 每分钟打多少次, 默认 28
 *        GAP    = 每次间隔秒, 默认 2   (ROUNDS×GAP 建议 ≈ 55, 别超 60)
 *   3. Settings → Triggers → Cron Triggers → * * * * *
 *
 * 主 worker 那边: 不需要 SELF / SELF_URL / 扇出, 它的 /report 被打时会把全部探针报掉即可。
 *   (主 worker 探针数 ≤ ~48 时一次 /report 就够; 更多请在 TARGET 后自行分 offset。)
 */

export default {
  async scheduled(event, env, ctx) {
    const target = (env.TARGET || "").replace(/\/+$/, "");
    if (!target) return;
    const rounds = Math.max(1, parseInt(env.ROUNDS || "28", 10));
    const gapMs = Math.max(0, parseInt(env.GAP || "2", 10)) * 1000;
    const gapSec = Math.max(1, parseInt(env.GAP || "2", 10));
    ctx.waitUntil((async () => {
      for (let i = 0; i < rounds; i++) {
        const start = Date.now();
        // spread=GAP: 让主 worker 把这批探针错开在间隔内上报, 时间戳不整齐划一
        try { await fetch(`${target}/report?spread=${gapSec}`); } catch (e) { /* 忽略单次失败 */ }
        if (i < rounds - 1) await new Promise((r) => setTimeout(r, Math.max(0, gapMs - (Date.now() - start))));
      }
    })());
  },

  // 手动测试: 打开驱动 worker 地址, 会立即驱动主 worker 一次并回显结果
  async fetch(request, env) {
    const target = (env.TARGET || "").replace(/\/+$/, "");
    if (!target) return new Response("❌ 未设置 TARGET(主 worker 地址)", { status: 500 });
    try {
      const r = await fetch(`${target}/report?spread=2`);
      const body = await r.text();
      return new Response(`驱动 → ${target}\nHTTP ${r.status}\n主worker返回: ${body}`,
        { headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (e) {
      return new Response("驱动失败: " + e, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  },
};
