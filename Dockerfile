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

# ★ 关键：在 builder 中就清理掉 devDependencies，这样 COPY 过去的 node_modules 就是干净的
RUN npm prune --omit=dev && \
    npm cache clean --force

# ===== 运行阶段 =====
FROM node:24-alpine

# 安装运行时依赖
RUN apk add --no-cache dumb-init

WORKDIR /app

# 从构建阶段复制 package.json（用于 npm start 等元数据）
COPY --from=builder /app/package.json ./

# 从构建阶段复制已清理的 node_modules（仅生产依赖 + 已编译的 native 模块）
COPY --from=builder /app/node_modules ./node_modules

# 从构建阶段复制构建产物
COPY --from=builder /app/dist ./dist

# 创建数据目录
RUN mkdir -p /app/data /app/dbdata

# 环境变量
ENV NODE_ENV=production

EXPOSE 8080

# 使用 dumb-init 处理信号
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
