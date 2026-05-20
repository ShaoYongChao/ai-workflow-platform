#!/bin/bash
# ============================================================
# AWP 平台启动脚本
# 用法：./scripts/start.sh [infra|app|gateway|admin|monitoring|quality|graph|all]
# ============================================================
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# 检查 .env
if [ ! -f ".env" ]; then
  echo "⚠️  未找到 .env，从模板创建..."
  cp .env.example .env
  echo "📝 请编辑 .env 填入 API Keys 后重新运行"
  exit 1
fi

# 检查 Docker
if ! docker info > /dev/null 2>&1; then
  echo "❌ Docker 未运行，请先启动 Docker Desktop"
  exit 1
fi

MODE=${1:-"all"}
echo "🚀 启动 AWP 平台 (模式: $MODE)"

case $MODE in
  "infra")
    echo "📦 启动基础设施..."
    docker-compose up -d redis postgres neo4j chroma elasticsearch zookeeper kafka kafka-ui
    ;;
  "app")
    echo "🔧 启动应用服务..."
    docker-compose up -d spec-normalizer code-generator executor planner-web retrieval memory-service
    ;;
  "gateway")
    echo "🌐 启动 Kong API 网关..."
    docker-compose up -d kong
    ;;
  "admin")
    echo "🖥  启动管理后台..."
    docker-compose up -d admin admin-web
    ;;
  "monitoring")
    echo "📊 启动监控..."
    docker-compose up -d prometheus grafana
    ;;
  "quality")
    echo "🔍 启动质量扫描..."
    docker-compose up -d sonarqube
    ;;
  "graph")
    echo "🕸  构建代码图谱..."
    docker-compose up -d neo4j
    echo "⏳ 等待 Neo4j 启动 (20s)..."
    sleep 20
    node knowledge-base/scripts/build-index.js
    node services/graph/src/build-graph.js
    ;;
  "all")
    echo "🌐 启动全部服务..."
    docker-compose up -d
    ;;
  *)
    echo "用法: $0 [infra|app|gateway|admin|monitoring|quality|graph|all]"
    exit 1
    ;;
esac

echo ""
echo "⏳ 等待健康检查 (5s)..."
sleep 5
echo ""
docker-compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null | head -25 || docker-compose ps

echo ""
cat << 'EOF'
📍 服务访问地址：
  策划输入界面:     http://localhost:3000
  管理后台:         http://localhost:3007
  管理后台 API:     http://localhost:3006
  VS Code 插件:     在 VS Code 中安装插件后使用

  Kong Gateway:     http://localhost:8000   (统一入口)
  Kong Admin:       http://localhost:8002   (仅开发环境)

  Kafka UI:         http://localhost:8080
  Neo4j Browser:    http://localhost:7474   (neo4j / $NEO4J_PASSWORD)
  Grafana:          http://localhost:3005   (admin / $GRAFANA_PASSWORD)
  Prometheus:       http://localhost:9090
  SonarQube:        http://localhost:9000
  Elasticsearch:    http://localhost:9200
  Chroma:           http://localhost:8001

🔧 初始化（首次启动后执行）：
  node knowledge-base/scripts/build-index.js     # 构建知识库索引
  node services/graph/src/build-graph.js          # 构建 Neo4j 图谱
  node knowledge-base/scripts/vectorize.js        # 写入 Chroma 向量库（可选）

🧪 验证：
  node scripts/e2e-test.js                        # 端到端逻辑验证
  ANTHROPIC_API_KEY=xxx node scripts/e2e-test.js  # 含真实 LLM 验证
EOF
