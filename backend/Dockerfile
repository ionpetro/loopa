FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY src/engine ./src/engine
COPY src/lib ./src/lib
COPY backend/*.ts ./backend/

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "--experimental-strip-types", "backend/server.ts"]
