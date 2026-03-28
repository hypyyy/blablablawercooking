FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts
COPY server.js ./

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
