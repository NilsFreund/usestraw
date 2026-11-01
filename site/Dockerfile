FROM nginxinc/nginx-unprivileged:1.31.6-alpine@sha256:884e0b7f42f303641b0f4e78755aea647521dca0b89ca3be7992ad78b5c07434

COPY --chmod=644 index.html impressum.html style.css copy.js mascot.webp favicon.png apple-touch-icon.png /usr/share/nginx/html/
COPY fonts /usr/share/nginx/html/fonts
COPY nginx/default.conf.template /etc/nginx/templates/
COPY --chmod=755 nginx/05-require-impressum.sh /docker-entrypoint.d/
