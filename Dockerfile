# 研数 · 容器镜像
#
# ⚠️ 这个文件**没有在本机验证过** —— 作者这台机器上没装 Docker，
#    没法 build 一遍。Caddyfile 和 systemd unit 都是照着官方文档写的、
#    不依赖本机环境，但 Dockerfile 的每一层都得真跑一次才知道对不对。
#    **第一次用之前请先在本机 build 一次**，确认能起来再上服务器。
#
# 用法：
#   docker build -t yanshu .
#   docker run -d --name yanshu \
#     -p 127.0.0.1:5180:5180 \
#     -e NODE_ENV=production \
#     -e REGISTRATION_ENABLED=false \
#     -v yanshu-data:/app/server/data \
#     yanshu
#
# `-p 127.0.0.1:5180:5180` 那个 127.0.0.1 前缀是**有意的**：
# 端口只绑到宿主机环回，外面进不来，HTTPS 由前面的 Caddy 终结
# （见 deploy/Caddyfile）。改成 `-p 5180:5180` 就是直接对公网开门了。

# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 是原生模块。多数平台能命中预编译包，但容器里的
# glibc 版本不一定对得上，装一套编译工具兜底。
# 只装在构建阶段，不会进最终镜像。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 先只拷清单文件再 npm ci：依赖没变时这一层能命中缓存，
# 改一行源码不用重装两分钟。
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
# check = 类型检查 + 构建前端。构建产物 web/dist 是后端要托管的东西，
# 少了它后端会退化成「只提供 API」，打开首页是 404。
RUN npm run check

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# ★ 容器里必须绑 0.0.0.0，否则宿主机的端口映射进不来
#   （默认的 127.0.0.1 是容器自己的环回）。
#   对外暴露与否由 `docker run -p` 决定，不由这个变量决定。
ENV HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./package.json

# 数据目录先建好并交给非 root 用户。不建的话首次启动会因为写不进
# app.db 而失败，而报错是 SQLITE_CANTOPEN —— 不太好往「目录权限」上想。
# 挂卷时要挂到 /app/server/data，别只挂文件。
RUN mkdir -p /app/server/data && chown -R node:node /app/server/data
USER node

EXPOSE 5180
CMD ["node", "server/src/index.js"]
