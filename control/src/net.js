// Network helpers for keeping sandboxes from talking back to the control plane.
import { cfg } from './config.js';
import { docker } from './proc.js';

/** IPv4 CIDR of the internal sandbox network, or null if Docker does not report one. */
export async function readSandboxSubnet() {
  const res = await docker(['network', 'inspect', cfg.sandboxNetwork, '-f', '{{range .IPAM.Config}}{{.Subnet}} {{end}}']);
  return res.stdout.trim().split(/\s+/).find((cidr) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr)) || null;
}

/** True when `address` (plain or IPv4-mapped IPv6) lies inside the IPv4 `cidr`. */
export function isInSubnet(address, cidr) {
  if (!address || !cidr) return false;
  const ipv4 = String(address).replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) return false;
  const [base, bits] = cidr.split('/');
  const toInt = (ip) => ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(ipv4) & mask) === (toInt(base) & mask);
}
