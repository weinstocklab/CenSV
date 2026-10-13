# syntax=docker/dockerfile:1
#
# Two stages: node compiles the front end, nginx serves the result. The runtime image is
# static files plus nginx; the toolchain, node_modules and source stay in the build stage.
#
# The browser's data is COPYed in at build time, so the image tag identifies the data
# exactly. web/public/data/meta.json carries the source commit of the analysis repository
# the data was built from.

# ----------------------------------------------------------------------------- build
# vite 8 requires node ^20.19 || >=22.12; node:22-alpine tracks the latest 22.x.
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a change to source or data does not re-resolve the tree.
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
# The build stops here when the data has yet to be generated.
RUN test -s public/data/catalog.json || \
      (echo "ERROR: web/public/data/catalog.json missing or empty - run etl/build_data.py first" && exit 1)
RUN npm run build


# --------------------------------------------------------------------------- runtime
FROM nginx:1.27-alpine AS runtime

# nginx:alpine ships a default site; replace it wholesale.
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/default.conf
COPY docker/nginx.conf /etc/nginx/conf.d/censv.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Run unprivileged. The stock image's master process wants port 80 and /var/cache, so the
# writable paths are handed to the nginx user and the listen port is >1024 - see
# nginx.conf. ECS maps the container port, so the published port is unaffected.
RUN touch /var/run/nginx.pid \
    && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080

# The health check asks for the data file, so a container answering 200 with an empty
# catalog is caught.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/data/meta.json || exit 1

CMD ["nginx", "-g", "daemon off;"]
