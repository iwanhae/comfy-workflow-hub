FROM oven/bun:1.3.14 AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY vite.config.ts tsconfig.json ./
COPY web/ ./web/
RUN bun run build

FROM oven/bun:1.3.14

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY --from=build /app/web/dist/ ./web/dist/

RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

ENV DATA_DIR=/app/data \
    HUB_HOST=0.0.0.0 \
    HUB_ALLOW_LAN=true

VOLUME /app/data
EXPOSE 3000
CMD ["bun", "run", "hub"]
