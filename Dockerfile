FROM node:24-alpine

# better-sqlite3 ships prebuilt binaries for most platforms, but building from
# source needs python3/make/g++ on alpine. Install them, then prune afterwards.
# su-exec lets the container start as root just long enough to fix the
# ownership of the mounted data folder, then run the app as "node".
RUN apk add --no-cache su-exec && apk add --no-cache --virtual .build-deps python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Native build deps no longer needed at runtime.
RUN apk del .build-deps

COPY server/ ./server/
COPY public/ ./public/

ENV NODE_ENV=production \
    DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
# -h: never follow a symlink inside data/ while still root. A NAS mount that
# refuses chown is not fatal; the app then reports what it can't write.
CMD ["sh", "-c", "chown -hR node:node /app/data 2>/dev/null || true; exec su-exec node node server/index.js"]
