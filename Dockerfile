FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN mkdir -p data
COPY src ./src
COPY data/hll-map-catalog.json ./data/hll-map-catalog.json
COPY data/hll-warfare-map-catalog.json ./data/hll-warfare-map-catalog.json
COPY railway.json ./railway.json

CMD ["npm", "start"]
