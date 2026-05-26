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
    find /app/node_modules \( -name '*.map' -o -name '*.d.ts' -o -name '*.md' \
      -o -name 'Makefile' -o -name '.npmignore' -o -name '*.yml' -o -name '*.yaml' \
      -o -name '.github' -o -name 'test' -o -name 'tests' -o -name 'example' \
      -o -name 'examples' -o -name 'doc' -o -name 'docs' -o -name '*.flow' \
      -o -name '*.tsbuildinfo' \) -delete

# ===== 运行阶段 =====
FROM node:24-alpine

# 创建必要目录
RUN mkdir -p /app/data /app/logs

WORKDIR /app

# 从构建阶段复制文件
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# 环境变量
ENV NODE_ENV=production

EXPOSE 8080

# 直接用 node 启动，避免 npm 额外进程开销
CMD ["node", "dist/index.js"]