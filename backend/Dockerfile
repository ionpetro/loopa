FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# The root package.json also carries the Next.js frontend; install only what
# backend/ and src/engine import (versions still pinned by the lockfile).
RUN node -e ' \
    const fs = require("fs"); \
    const keep = ["@ai-sdk/anthropic", "@ai-sdk/openai", "@clerk/backend", "@modelcontextprotocol/sdk", \
      "@onkernel/sdk", "ai", "clsx", "perfect-cursors", "pg", "playwright-core", "tailwind-merge", "zod"]; \
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); \
    pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => keep.includes(name))); \
    delete pkg.devDependencies; \
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2)); \
  ' \
  && npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY src/engine ./src/engine
COPY src/lib ./src/lib
COPY backend/*.ts ./backend/

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "--experimental-strip-types", "backend/server.ts"]
