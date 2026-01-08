FROM node:18-alpine

# Installer FFmpeg et dépendances
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copier package.json
COPY package*.json ./

# Installer dépendances
RUN npm install --only=production

# Copier le code source
COPY . .

# Exposer le port
EXPOSE 3000

# Optimisation mémoire
ENV NODE_OPTIONS="--max-old-space-size=200"

# Démarrer l'application
CMD ["node", "app.js"]
