# cogpath: one image for the API service (default command) and the worker job (command override).
FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# The root postinstall installs web/ dependencies, which the runtime image does not need.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY core/ ./core/
COPY server/ ./server/
COPY worker/ ./worker/
COPY cli.js ./
COPY --from=web /app/web/dist ./web/dist
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
