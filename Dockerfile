# ===== 构建阶段 =====
FROM node:24-alpine AS builder

# 安装编译依赖（better-sqlite3 需要）
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 先复制依赖文件，利用缓存
COPY package.json package-lock.json ./

# 安装所有依赖（包括 devDependencies）
RUN npm ci

# 复制源码和配置
COPY tsconfig.json ./
COPY src ./src

# 构建项目
RUN npm run build

# ===== 运行阶段 =====
FROM node:24-alpine

# 安装运行时依赖
RUN apk add --no-cache dumb-init

WORKDIR /app

# 从构建阶段复制构建产物
COPY --from=builder /app/dist ./dist

# 从构建阶段复制 package 文件
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./

# 从构建阶段复制编译好的 node_modules（包含 native 模块）
COPY --from=builder /app/node_modules ./node_modules

# 清理不需要的 devDependencies 包，保留 native 模块
RUN npm prune --omit=dev && \
    npm cache clean --force

# 创建数据目录
RUN mkdir -p /app/data /app/dbdata

# 环境变量
ENV NODE_ENV=production

EXPOSE 8080

# 使用 dumb-init 处理信号
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
