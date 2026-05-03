FROM node:20-alpine

# 安装运行时依赖（dumb-init 用于正确处理信号）
RUN apk add --no-cache dumb-init

WORKDIR /app

# 复制依赖清单
COPY package.json package-lock.json ./

# 复制源码
COPY tsconfig.json ./
COPY src ./src

# 安装依赖 → 编译 → 裁剪 devDependencies（同一层，避免残留）
RUN apk add --no-cache python3 make g++ && \
    npm ci && \
    npm run build && \
    npm prune --omit=dev && \
    npm cache clean --force && \
    apk del python3 make g++

# 创建数据目录
RUN mkdir -p /app/data /app/dbdata

# 环境变量
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# 使用 dumb-init 处理信号
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
