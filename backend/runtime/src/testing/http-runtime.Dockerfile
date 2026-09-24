# 不包含 Node 的中性测试镜像，用于证明生命周期和探针没有业务工具依赖。
FROM alpine:3.21
RUN apk add --no-cache busybox-extras && adduser -D app && mkdir -p /srv /data && echo ok > /srv/health && chown app:app /srv /data
USER app
EXPOSE 8080
COPY --chmod=755 start-http.sh /usr/local/bin/start-http
ENTRYPOINT ["/usr/local/bin/start-http"]
CMD ["-f", "-p", "8080", "-h", "/srv"]
