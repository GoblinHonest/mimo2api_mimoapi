# Docker 部署指南

## 快速开始

### 1. 构建并启动

```bash
docker-compose up -d
```

### 2. 查看日志

```bash
docker-compose logs -f
```

### 3. 停止服务

```bash
docker-compose down
```

## 数据持久化

数据目录会挂载到宿主机：
- `./data` - 应用数据目录
- `./dbdata` - SQLite 数据库目录（含 `mimo-proxy.db`）

## 端口配置

默认端口是 8080，可以在 `docker-compose.yml` 中修改：
```yaml
ports:
  - "3000:8080"  # 宿主机端口:容器端口
```

## 更新部署

```bash
# 拉取最新代码
git pull

# 重新构建并启动
docker-compose up -d --build
```

## 仅使用 Docker（不用 docker-compose）

```bash
# 构建镜像
docker build -t mimo-proxy .

# 运行容器
docker run -d \
  --name mimo-proxy \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/dbdata:/app/dbdata \
  mimo-proxy
```
