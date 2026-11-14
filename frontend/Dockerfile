FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The API proxy target is fixed when the app is built.
ARG BACKEND_URL=http://backend:4780
ENV BACKEND_URL=$BACKEND_URL
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json /app/next.config.ts ./
ARG BACKEND_URL=http://backend:4780
ENV BACKEND_URL=$BACKEND_URL
USER node
EXPOSE 4790
CMD ["npx", "next", "start", "-p", "4790"]
