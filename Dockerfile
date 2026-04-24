FROM node:20-alpine

# 安装 better-sqlite3 需要的构建工具
RUN apk add --no-cache python3 make g++ dumb-init

WORKDIR /app

# 复制依赖文件
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

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
