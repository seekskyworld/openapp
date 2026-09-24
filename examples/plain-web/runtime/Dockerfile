FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY server.mjs /app/server.mjs
COPY --chmod=755 start.sh /app/start.sh
USER node
EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
CMD ["node", "/app/server.mjs"]
