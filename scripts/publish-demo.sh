#!/usr/bin/env bash
# 演示站那份：本机 build → 从真产物挑出已发布的内容 → 推静态文件上服务器。
#
# 单向：Mac 是唯一事实源，推上去的只是一份脱敏快照，不在那边改、也不在那边跑任务。
# ⚠️ 2026-11-02 起 media.buildhub.cn 反代的是真工作台那一份，这个静态目录没有 vhost 在服务了，
#    跑这一支只是推一份没人看的快照。dist-demo 本身还得留着——宣传片的交互片段在本地起它录。
# 用法：scripts/publish-demo.sh [--skip-build]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${WEB_HOST:-smzs-server}"
WEB="${WEB_DEMO_ROOT:-/www/wwwroot/media.buildhub.cn}"

cd "$ROOT"
[[ "${1:-}" == "--skip-build" ]] || npm run build >/dev/null
node scripts/build-demo-data.mjs
rsync -az --delete dist-demo/ "$HOST:$WEB/"
# nginx 的 worker 跑在 www 下，属主不对就是 403
ssh "$HOST" "chown -R www:www $WEB"
echo "[demo] 已推 $HOST:$WEB"
