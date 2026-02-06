FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN npm install

COPY apps apps
COPY packages packages

EXPOSE 3001

CMD ["npm","--workspace","apps/api","run","dev","--","--host","0.0.0.0"]
