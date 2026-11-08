// Official WordPress Agent Skills (WordPress/agent-skills, GPL, shipped unmodified in knowledge/).
// The agent reads them on demand through the wp_guide tool (progressive disclosure),
// and the security baseline is embedded in the system prompt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'knowledge', 'wp-agent-skills');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.md') && e.name !== 'NOTICE.md' ? [p] : [];
  });
}

function describe(text) {
  const fm = text.match(/^---\n[\s\S]*?description:\s*"?(.+?)"?\n[\s\S]*?---/);
  if (fm) return fm[1].slice(0, 220);
  const h = text.match(/^#\s+(.+)$/m);
  const use = text.match(/^Use this file (.+)$/m);
  return [h && h[1], use && `use ${use[1]}`].filter(Boolean).join(': ').slice(0, 220);
}

let INDEX = [];
try {
  INDEX = walk(ROOT)
    .map((f) => {
      const id = path.relative(ROOT, f).split(path.sep).join('/');
      return { id, description: describe(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
} catch {
  INDEX = [];
}

export const guideIndex = () => INDEX;

export function readGuide(id) {
  const doc = INDEX.find((d) => d.id === String(id || '').replace(/^\/+/, ''));
  if (!doc) return null;
  return fs.readFileSync(path.join(ROOT, ...doc.id.split('/')), 'utf8').replace(/\r\n/g, '\n');
}

export function securityBaseline() {
  return readGuide('plugin-development/references/security.md') || '';
}
