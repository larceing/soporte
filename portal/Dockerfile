FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Madrid

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Versión de la imagen (la pone GitHub Actions: sha-1a2b3c4, v1.2.0). La
# devuelve /version/, que es lo que mira el servidor DEV/PRO.
ARG APP_VERSION=local
ENV APP_VERSION=$APP_VERSION
LABEL org.opencontainers.image.version=$APP_VERSION

USER node
EXPOSE 3000
CMD ["node", "server.js"]
