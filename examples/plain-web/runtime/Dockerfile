FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY server.mjs /app/server.mjs
COPY --chmod=755 start.sh /app/start.sh
USER node
EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
CMD ["node", "/app/server.mjs"]
