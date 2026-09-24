FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY server.mjs /app/server.mjs
COPY --chmod=755 start.sh /app/start.sh
USER node
EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
CMD ["node", "/app/server.mjs"]
