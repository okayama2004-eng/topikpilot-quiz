FROM node:20-alpine
WORKDIR /app
COPY package.json server.js index.html tiktok.js ./
EXPOSE 3000
CMD ["node", "server.js"]
