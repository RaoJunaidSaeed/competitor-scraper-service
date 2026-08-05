# Official Playwright image — Chromium + all system dependencies (fonts,
# codecs, etc.) preinstalled. This avoids the common "browser launch fails
# with missing shared library" errors that happen on generic Node buildpacks.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
