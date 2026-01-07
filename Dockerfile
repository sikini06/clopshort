FROM node:18-alpine

# Installer FFmpeg et dépendances
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copier les fichiers package
COPY package*.json ./

# Installer les dépendances
RUN npm install --only=production

# Copier le code source
COPY . .

# Créer un utilisateur non-root pour la sécurité
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001

# Changer les permissions
RUN chown -R nodeuser:nodejs /app

# Passer à l'utilisateur non-root
USER nodeuser

# Exposer le port
EXPOSE 3000

# Commande de démarrage
CMD ["npm", "start"]
