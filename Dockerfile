FROM node:22-slim
# DejaVu Sans is the PNG font (it covers Hebrew and Arabic); resvg loads system fonts.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build --config vite.config.js
# Off loopback the server requires VOLTBRIDGE_TOKEN (set it on the host) and keeps chat off.
ENV HOST=0.0.0.0 PORT=8430 VOLTBRIDGE_SESSIONS=/data/sessions
EXPOSE 8430
CMD ["node", "server.js"]
