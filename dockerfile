FROM node:22.23.2-alpine

WORKDIR /app

RUN npm install -g pnpm@8.15.9

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/src/main"]