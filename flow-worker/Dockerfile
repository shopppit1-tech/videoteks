FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY flow-worker/package*.json ./
RUN npm install --omit=dev
COPY flow-worker/flow-worker.js ./flow-worker.js
ENV NODE_ENV=production
ENV FLOW_WORKER_PORT=10000
EXPOSE 10000
CMD ["node", "flow-worker.js"]
