#!/usr/bin/env node
// End-to-end smoke test against a running stack.
// Usage: node scripts/smoke.mjs [reservasi|kurs|promo|tagline|all] [--apply]
const BASE = process.env.PB_URL || 'http://localhost:8300';
const SCENARIOS = {
  reservasi: { msg: 'Tambahkan form reservasi meja di halaman Kontak: nama, nomor WhatsApp, tanggal, jam, dan jumlah orang.', expect: 'review' },
  kurs: { msg: 'Tampilkan kurs dolar hari ini dari API luar di Beranda.', expect: 'blocked' },
  promo: { msg: 'Pasang banner promo paket kopi di Beranda, harganya diturunkan bertahap sampai di bawah Rp20.000.', expect: 'blocked' },
  tagline: { msg: 'Ganti tagline situs jadi "Kopi enak, obrolan hangat".', expect: 'review' },
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const pick = args.find((a) => !a.startsWith('--')) || 'reservasi';
const names = pick === 'all' ? Object.keys(SCENARIOS) : [pick];

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const get = async (p) => (await fetch(BASE + p)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = ['review', 'blocked', 'error', 'applied', 'apply_failed', 'discarded'];

let failures = 0;
for (const name of names) {
  const s = SCENARIOS[name];
  console.log(`\n=== ${name}: "${s.msg}"`);
  const t0 = Date.now();
  const { status, data } = await post('/api/tasks', { message: s.msg });
  if (status !== 201) {
    console.log('  gagal membuat tugas:', data);
    failures++;
    continue;
  }
  let task;
  do {
    await sleep(1500);
    task = await get(`/api/tasks/${data.id}`);
  } while (!FINAL.includes(task.status) && Date.now() - t0 < 9 * 60 * 1000);

  console.log(`  status: ${task.status} (${Math.round((Date.now() - t0) / 1000)} dtk)`);
  for (const c of task.verdict?.checks || []) console.log(`  ${c.ok ? '✓' : '✕'} ${c.name}: ${c.detail}`);
  console.log(`  ringkasan agen: ${task.summary}`);
  console.log(`  perubahan: ${Object.keys(task.changeset.files).join(', ') || '-'}; ${task.changeset.commands.length} perintah`);

  if (task.status !== s.expect) {
    console.log(`  HASIL TIDAK SESUAI: harap ${s.expect}`);
    failures++;
  }
  if (task.status === 'review') {
    const act = apply ? 'apply' : 'discard';
    const r = await post(`/api/tasks/${data.id}/${act}`, {});
    console.log(`  ${act}:`, JSON.stringify(r.data));
    if (act === 'apply' && !r.data.ok) failures++;
  }
}
console.log(failures ? `\n${failures} skenario gagal.` : '\nSemua skenario sesuai harapan.');
process.exit(failures ? 1 : 0);
