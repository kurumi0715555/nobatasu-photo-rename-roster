FROM node:22-bookworm-slim AS package
WORKDIR /src
COPY . .
RUN apt-get update && apt-get install -y --no-install-recommends python3
RUN npm ci --ignore-scripts
RUN python3 scripts/build.py

FROM php:8.3-apache AS web
COPY --from=package /src/build/site/ /var/www/html/
RUN printf '%s\n' '<Directory /var/www/html>' '  Options -Indexes' '  AllowOverride None' '</Directory>' > /etc/apache2/conf-available/static-app.conf && a2enconf static-app
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD php -r 'exit(@file_get_contents("http://127.0.0.1/index.html") === false ? 1 : 0);'
