FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
ENV BASE_PATH=/ui
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY --chmod=755 start.sh /app/start.sh
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
CMD ["node", "/app/backend/server.mjs"]
