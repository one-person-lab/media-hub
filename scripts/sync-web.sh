#!/usr/bin/env bash
# 把这台电脑上的工作台快照推到服务器那一份（网页版）。
# 方向只有一个：本机 → 服务器。网页版上的改动不会被这台机器的旧文件盖掉
# （内容、配置、读数走 --update：服务器上一旦比本地新，就跳过不覆盖，改完记得回本机对账）。
# 界面产物是纯构建物，直接 --delete 对齐；采集下来的源片（source.mp4）不推，那 900M 只在本机看。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${WEB_HOST:-smzs-server}"
APP="${WEB_APP:-/opt/media-hub}"

if [[ "${1:-}" == "--build" ]]; then
  echo "[sync] 先构建界面"
  (cd "$ROOT" && npm run build >/dev/null)
fi

echo "[sync] dist → $HOST"
rsync -az --delete --exclude 'source.mp4' "$ROOT/dist/" "$HOST:$APP/dist/"

echo "[sync] scripts → $HOST"
rsync -az --delete "$ROOT/scripts/" "$HOST:$APP/scripts/"
scp -q "$ROOT/package.json" "$HOST:$APP/package.json"

echo "[sync] content / config / metrics → $HOST（服务器上更新的跳过）"
rsync -az --update "$ROOT/content/" "$HOST:$APP/content/"
rsync -az --update "$ROOT/config/" "$HOST:$APP/config/"
rsync -az --update --exclude 'account-cookies/' --exclude 'selfcheck.json' \
  "$ROOT/metrics/" "$HOST:$APP/metrics/"

echo "[sync] 缺依赖就补：发登录码要 nodemailer，node_modules 不在上面的 rsync 清单里"
if ! ssh "$HOST" "test -d $APP/node_modules/nodemailer"; then
  ssh "$HOST" "cd $APP && npm install --no-save --omit=dev --no-audit --no-fund >/dev/null"
fi

echo "[sync] 重启那一份，让它按新数据重算读数"
ssh "$HOST" "chown -R root:root $APP && systemctl restart media-hub && sleep 2 && systemctl is-active media-hub"
