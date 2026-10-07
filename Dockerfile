FROM node:22-slim
WORKDIR /srv
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev && npm cache clean --force
COPY app/ app/
COPY server/ server/
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "--no-warnings", "server/server.js"]
