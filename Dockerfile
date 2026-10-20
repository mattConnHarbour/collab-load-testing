FROM mcr.microsoft.com/playwright:v1.64.0-noble AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client
COPY . .
RUN npm run build

FROM runtime AS server
EXPOSE 8100
CMD ["npm", "run", "server"]

FROM runtime AS observer
EXPOSE 3100
CMD ["npm", "run", "observer", "--", "--host", "0.0.0.0", "--port", "3100"]

FROM runtime AS generator
ENTRYPOINT ["node", "scripts/load-test.mjs"]
