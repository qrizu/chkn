FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/

RUN npm install

COPY apps/web apps/web

EXPOSE 5173

CMD ["npm","--workspace","apps/web","run","dev","--","--host","0.0.0.0","--port","5173"]
