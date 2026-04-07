FROM node:25-alpine 

RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY . .

RUN npm install

ENV NODE_ENV=production

RUN npm run build

EXPOSE 3002

CMD ["node", "build/index.js"]
