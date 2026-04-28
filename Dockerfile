FROM node:20-alpine

# 安装运行时依赖（dumb-init 用于正确处理信号）
RUN apk add --no-cache dumb-init

WORKDIR /app

# 复制依赖清单
COPY package.json package-lock.json ./

# 安装构建依赖 → 编译 better-sqlite3 → 立即移除构建工具
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    apk del python3 make g++ && \
    npm cache clean --force

# 复制源码
COPY tsconfig.json tailwind.config.js ./
COPY src ./src

# 创建数据目录
RUN mkdir -p /app/data /app/dbdata

# 环境变量
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# 使用 dumb-init 处理信号
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
