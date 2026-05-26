# ===== 构建阶段 =====
FROM node:24-alpine AS builder

WORKDIR /app

# 先复制依赖文件，利用缓存
COPY package.json package-lock.json ./

# 安装所有依赖（包括 devDependencies）
RUN npm ci

# 复制源码和配置
COPY tsconfig.json ./
COPY src ./src

# 构建项目并清理
RUN npm run build && \
    npm prune --omit=dev && \
    npm cache clean --force && \
    rm -rf /app/node_modules/chart.js /app/node_modules/@kurkle/color && \
    find /app/node_modules \( -name '*.map' -o -name '*.d.ts' -o -name 'README*' \
      -o -name 'CHANGELOG*' -o -name 'LICENSE*' \) -delete

# ===== 运行阶段 =====
FROM node:24-alpine

# 安装运行时依赖并创建目录
RUN apk add --no-cache dumb-init && \
    mkdir -p /app/data /app/logs

WORKDIR /app

# 从构建阶段复制文件
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# 环境变量
ENV NODE_ENV=production

EXPOSE 8080

# 使用 dumb-init 处理信号
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]