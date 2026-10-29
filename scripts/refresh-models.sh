#!/usr/bin/env bash
# 刷新 pii 的 models.json：从服务器上的 magpie 拉最新模型目录。
#
# 为什么需要手动跑：pii 的 provider.ts 是**静态读 models.json** 的，不会自己发现新模型。
# 所以 Mac 那边加了供应商/模型、或者在服务器 magpie 里加了 API key 供应商之后，
# 跑一次这个脚本，pii 的模型选择器才会更新。
#
# 用法（在服务器上）：
#   ./scripts/refresh-models.sh [容器名] [数据目录]
set -euo pipefail

MAGPIE="${1:-magpie}"
MODELS_DIR="${2:-/opt/pii-test/models}"
TARGET="$MODELS_DIR/models.json"

# 网关密钥：pii 连 magpie 用的那把（第一次由 gateway-key add pii 生成后保存）
KEY_FILE="$MODELS_DIR/gateway-key"
if [ ! -s "$KEY_FILE" ]; then
  echo "缺少网关密钥：$KEY_FILE" >&2
  echo "先生成：docker exec $MAGPIE magpie gateway-key add pii > $KEY_FILE" >&2
  exit 1
fi

echo "① 从 $MAGPIE 拉模型目录…"
docker exec "$MAGPIE" sh -c 'curl -s http://127.0.0.1:3425/v1/models' > /tmp/magpie-models.json

echo "② 生成 models.json…"
KEY="$(tr -d '[:space:]' < "$KEY_FILE")" node -e '
const fs = require("node:fs");
const raw = JSON.parse(fs.readFileSync("/tmp/magpie-models.json", "utf8"));
const models = raw.data.map((m) => {
  const input = Array.isArray(m.modalities?.input) ? m.modalities.input : ["text"];
  return {
    id: m.id,
    name: m.display_name || m.id,
    input: input.includes("image") ? ["text", "image"] : ["text"],
    reasoning: Boolean(m.reasoning),
    contextWindow: m.context_window || m.context_length || 128000,
    maxTokens: m.max_output_tokens || 8192,
  };
});
const out = {
  providers: {
    magpie: {
      api: "openai-completions",
      baseUrl: "http://magpie:3425/v1",
      apiKey: process.env.KEY,
      models,
    },
  },
};
fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2));
console.log(`   ${models.length} 个模型 · 图片 ${models.filter((m) => m.input.length > 1).length} 个 · 思考 ${models.filter((m) => m.reasoning).length} 个`);
' "$TARGET"

echo "③ 重启 pii 让新目录生效…"
docker restart "${PII_CONTAINER:-pii-test}" >/dev/null
echo "完成。"
