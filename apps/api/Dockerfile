FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 py3-setuptools make g++ tzdata icu-data-full

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN npm install

COPY apps apps
COPY packages packages

EXPOSE 3001

ENV NODE_ICU_DATA=/app/apps/api/node_modules/full-icu
ENV TZ=Europe/Stockholm

CMD ["npm","--workspace","apps/api","run","dev","--","--host","0.0.0.0"]
