#!/bin/bash
# First-boot script for a PressBox VM on Vultr (passed as user_data by provision-vultr.mjs).
# Contains no secrets: .env is copied over SSH after the VM is up.
set -e

# Builds and the sandbox need headroom on a 2 GB plan.
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

if command -v ufw >/dev/null; then
  ufw allow 22/tcp
  ufw allow 8080/tcp
  ufw allow 8300/tcp
  ufw allow 8301/tcp
fi

curl -fsSL https://get.docker.com | sh
git clone https://github.com/erzawansyah/pressbox.git /opt/pressbox
cd /opt/pressbox && docker compose build
touch /opt/pressbox/.bootstrap-done
