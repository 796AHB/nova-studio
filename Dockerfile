FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
EXPOSE 8787
USER node
HEALTHCHECK CMD wget -qO- http://localhost:8787/healthz || exit 1
CMD ["node", "server.js"]
