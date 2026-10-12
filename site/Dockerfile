FROM nginxinc/nginx-unprivileged:1.31.5-alpine@sha256:19c132c9ab02d3b783f478743dafc7a7f42e27aa7d2bdcbec1bb1128ca8f2a07

COPY --chmod=644 index.html impressum.html style.css copy.js mascot.webp favicon.png apple-touch-icon.png /usr/share/nginx/html/
COPY fonts /usr/share/nginx/html/fonts
COPY nginx/default.conf.template /etc/nginx/templates/
COPY --chmod=755 nginx/05-require-impressum.sh /docker-entrypoint.d/
