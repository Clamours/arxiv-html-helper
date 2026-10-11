#!/bin/sh
# 把 src/assets/icon.svg 导出为扩展图标 public/icon/{16,32,48,128}.png（WXT 会自动写进 manifest），
# 同时导出主页图标和 Chrome 应用商店的小型宣传图块（store/promo-small.png）
# 依赖 macOS 自带的 sips 和本机安装的 Google Chrome：先用 Chrome 按 512px 渲染，再用 sips 缩小
set -e
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p public/icon

render() { # $1 = svg, $2 = 输出 png（512px）
  printf '<html><body style="margin:0"><img src="file://%s" width="512" height="512"></body></html>' "$PWD/$1" > "$TMP/page.html"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size=512,512 --screenshot="$2" "file://$TMP/page.html" 2>/dev/null
}

render src/assets/icon.svg "$TMP/icon.png"
for size in 16 32 48 128; do sips -z $size $size "$TMP/icon.png" --out "public/icon/$size.png" >/dev/null; done

# 项目主页（site/）用的图标
cp public/icon/128.png site/icon.png
cp public/icon/32.png site/icon-32.png

# Chrome 应用商店的小型宣传图块：按 2 倍渲染再缩到 440×280
"$CHROME" --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=2 \
  --window-size=440,280 --screenshot="$TMP/promo.png" "file://$PWD/store/promo-small.html" 2>/dev/null
sips -z 280 440 "$TMP/promo.png" --out store/promo-small.png >/dev/null
