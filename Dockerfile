FROM node:lts

ENV KINDROID_INFER_URL="https://api.kindroid.ai/v1/discord-bot"

RUN mkdir -p /home/node/kindroid/src
WORKDIR /home/node/kindroid/

COPY package*.json .
RUN npm install

COPY . .
RUN chown -R node:node /home/node/kindroid/
USER node

CMD ["npm","start"]