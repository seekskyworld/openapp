ARG NGINX_BASE_IMAGE=nginx:stable-alpine@sha256:ef8676b33d681f272ba429b27658bdd7e640963279714c96bddf1dc76307f7b6
FROM ${NGINX_BASE_IMAGE}

ARG OPENAPP_DEPLOYMENT_SOURCE_SHA256
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY web /usr/share/nginx/html
LABEL io.openapp.deployment-source-sha256="${OPENAPP_DEPLOYMENT_SOURCE_SHA256}"

# 配置已在导出时生成；绕过上游会查询包索引/改写配置的初始化脚本，确保离线启动。
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
