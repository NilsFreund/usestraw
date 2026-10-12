FROM nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:adf5042a17f4ecdd200c595fa9ffd1be37efb18f89a830bd1a00e4ab4d59d42c

COPY --chmod=644 index.html impressum.html style.css copy.js mascot.webp favicon.png apple-touch-icon.png /usr/share/nginx/html/
COPY fonts /usr/share/nginx/html/fonts
COPY nginx/default.conf.template /etc/nginx/templates/
COPY --chmod=755 nginx/05-require-impressum.sh /docker-entrypoint.d/
