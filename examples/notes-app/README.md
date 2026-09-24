# Notes：不依赖 OpenApp 的单人 Web 应用

`frontend/` 是网页，`backend/server.mjs` 提供静态页面与 `/api/note`，笔记存入
`/data/note.json`。这份业务代码没有用户、租户或 Adapter 概念。

Dockerfile 将前后端装入一个非 root 容器，监听 8080，健康接口为 `/health`。
后端支持普通部署配置 `BASE_PATH`；直接运行默认根路径，镜像设置为 `/ui`，
对应页面 `/ui/` 和接口 `/ui/api/note`。Core 代理只去掉 `/instances/<id>`，保留 `/ui/`。
应用不提供身份验证，部署到 OpenApp 后仅通过受保护的工作区代理访问，不公开容器端口。

按 OpenApp Core 仓库中的 `docs/adapter-tutorial.md` 复制为独立应用仓库，再使用单独的
Notes Adapter；完整验收包含两个用户的数据隔离与停止后再启动的数据保留。
