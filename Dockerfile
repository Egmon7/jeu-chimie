FROM node:24.22.1-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY --chown=node:node server/ ./server/
COPY --chown=node:node public/ ./public/

RUN chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=4173
ENV HOST=0.0.0.0

USER node

EXPOSE 4173

CMD ["node", "server/index.js"]
