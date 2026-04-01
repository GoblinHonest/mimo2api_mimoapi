# ============================================
# Stage 1: Build
# ============================================
FROM node:20-alpine AS builder

# better-sqlite3 需要的构建工具
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 先复制依赖文件，利用 Docker 缓存
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码并编译 TypeScript
COPY tsconfig.json ./
COPY src ./src

# 如果有 tailwind 构建步骤，这里可以添加
# RUN npx @tailwindcss/cli -i ./src/web/input.css -o ./src/web/style.css

# ============================================
# Stage 2: Production
# ============================================
FROM node:20-alpine

# better-sqlite3 运行时也需要 python3 (某些情况)
RUN apk add --no-cache dumb-init

WORKDIR /app

# 复制依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 复制编译产物和静态文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/web ./src/web

# 创建数据目录
RUN mkdir -p /app/data

# 环境变量 (可在 docker-compose 或运行时覆盖)
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# 使用 dumb-init 处理信号
ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/index.ts"]
