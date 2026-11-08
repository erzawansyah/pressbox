#!/usr/bin/env node
// Provisions a PressBox VM on Vultr through the Vultr API (v2): registers an SSH key,
// creates a Cloud Compute instance with scripts/cloud-init.sh as user_data, and waits for
// its IP. Afterwards copy .env to /opt/pressbox and run `docker compose up -d`.
//
// Usage: VULTR_API_KEY=... node scripts/provision-vultr.mjs --ssh-key ~/.ssh/pressbox_vultr.pub
// Options: --region sgp --plan vc2-1c-2gb --label pressbox-control
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.vultr.com/v2';
const UBUNTU_24_04_NAME = /^Ubuntu 24\.04 LTS x64$/;
const POLL_MS = 10_000;
const MAX_WAIT_MS = 10 * 60 * 1000;

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
};
const region = option('region', 'sgp');
const plan = option('plan', 'vc2-1c-2gb');
const label = option('label', 'pressbox-control');
const sshKeyPath = option('ssh-key', path.join(os.homedir(), '.ssh', 'pressbox_vultr.pub')).replace(/^~/, os.homedir());

const apiKey = process.env.VULTR_API_KEY;
if (!apiKey) {
  console.error('Set VULTR_API_KEY (a Vultr account API key with provisioning rights).');
  process.exit(2);
}

async function vultr(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function ensureSshKey(publicKey) {
  const { ssh_keys: existing = [] } = await vultr('GET', '/ssh-keys');
  const match = existing.find((key) => key.ssh_key.trim() === publicKey.trim());
  if (match) return match.id;
  const { ssh_key: created } = await vultr('POST', '/ssh-keys', { name: label, ssh_key: publicKey });
  return created.id;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const userData = fs.readFileSync(path.join(scriptDir, 'cloud-init.sh')).toString('base64');
const publicKey = fs.readFileSync(sshKeyPath, 'utf8');

const { os: images } = await vultr('GET', '/os?per_page=500');
const ubuntu = images.find((image) => UBUNTU_24_04_NAME.test(image.name));
if (!ubuntu) throw new Error('Ubuntu 24.04 image not found.');

const sshKeyId = await ensureSshKey(publicKey);
const { instance } = await vultr('POST', '/instances', {
  region,
  plan,
  os_id: ubuntu.id,
  label,
  hostname: label,
  sshkey_id: [sshKeyId],
  user_data: userData,
  backups: 'disabled',
  tags: ['pressbox'],
});
console.log(`Created ${instance.id} (${plan} in ${region}); waiting for an IP...`);

const startedAt = Date.now();
let current = instance;
while (Date.now() - startedAt < MAX_WAIT_MS) {
  ({ instance: current } = await vultr('GET', `/instances/${instance.id}`));
  if (current.status === 'active' && current.main_ip && current.main_ip !== '0.0.0.0') break;
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
console.log(`Instance ${current.status}, IP ${current.main_ip}.`);
console.log('Cloud-init now installs Docker and builds PressBox (about 5 minutes). Then:');
console.log(`  scp .env root@${current.main_ip}:/opt/pressbox/.env`);
console.log(`  ssh root@${current.main_ip} 'cd /opt/pressbox && docker compose up -d'`);
