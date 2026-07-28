# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# VITE_ values below are public on-chain deployment identifiers embedded in
# the browser bundle. No credential is accepted by this image.

FROM node:26.0.0-alpine AS build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend .
COPY scripts/verify-frontend-release-env.mjs /app/scripts/verify-frontend-release-env.mjs

ARG VITE_TOKEN_IN_ADDRESS
ARG VITE_TOKEN_OUT_ADDRESS
ARG VITE_SHIELDED_TOKEN_IN_ADDRESS
ARG VITE_SHIELDED_TOKEN_OUT_ADDRESS
ARG VITE_SWAP_SHIELD_ROUTER_ADDRESS
ARG VITE_CHAIN_ID
ARG VITE_POOL_FEE

ENV VITE_TOKEN_IN_ADDRESS=$VITE_TOKEN_IN_ADDRESS
ENV VITE_TOKEN_OUT_ADDRESS=$VITE_TOKEN_OUT_ADDRESS
ENV VITE_SHIELDED_TOKEN_IN_ADDRESS=$VITE_SHIELDED_TOKEN_IN_ADDRESS
ENV VITE_SHIELDED_TOKEN_OUT_ADDRESS=$VITE_SHIELDED_TOKEN_OUT_ADDRESS
ENV VITE_SWAP_SHIELD_ROUTER_ADDRESS=$VITE_SWAP_SHIELD_ROUTER_ADDRESS
ENV VITE_CHAIN_ID=$VITE_CHAIN_ID
ENV VITE_POOL_FEE=$VITE_POOL_FEE

RUN npm run build:release

FROM nginx:1.29.5-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
