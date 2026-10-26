FROM node:22-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /data/uploads && chown -R node:node /app /data
ENV NODE_ENV=production PORT=4000 DB_PATH=/data/briefs.sqlite UPLOAD_DIR=/data/uploads COOKIE_SECURE=true
EXPOSE 4000
USER node
CMD ["npm", "run", "start"]
