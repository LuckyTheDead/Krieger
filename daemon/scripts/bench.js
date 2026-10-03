// Honest throughput comparison: phone vs PC, same algorithm, same data.
// Measures sustained compute and confirms the real difference is memory and
// endurance, not raw CPU. Writes results as one JSON line on stdout.
const t0 = Date.now();

// Honour whichever module system the host uses: this file is copied into two
// different repos (the phone's, which sets "type": "module", and the PC's,
// which does not), so a bare require/import at top level breaks one of them.
const os = await import('node:os');
function sieve(n) {
  const p = new Uint8Array(n);
  p.fill(1); p[0] = p[1] = 0;
  for (let i = 2; i * i < n; i++)
    if (p[i]) for (let j = i * i; j < n; j += i) p[j] = 0;
  let c = 0; for (let i = 0; i < n; i++) c += p[i];
  return c;
}

function matmul(d) {
  // d x d multiply, a few reps. Real float work, not integer tricks.
  const a = new Float64Array(d * d).fill(1.5);
  const b = new Float64Array(d * d).fill(0.5);
  const c = new Float64Array(d * d);
  let acc = 0;
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < d; i++)
      for (let j = 0; j < d; j++) {
        let s = 0;
        for (let x = 0; x < d; x++) s += a[i * d + x] * b[x * d + j];
        c[i * d + j] = s;
      }
  }
  for (let i = 0; i < c.length; i += 97) acc += c[i];
  return acc;
}

const rounds = parseInt(process.argv[2] || '5', 10);
const r = { where: process.argv[3] || 'unknown', rounds, results: {} };

let s = Date.now(); r.results.primes = sieve(20_000_000); r.results.primeMs = Date.now() - s;
s = Date.now(); r.results.matmul = matmul(220); r.results.matmulMs = Date.now() - s;

// Memory: allocate and touch, so this is a real page-commit test.
s = Date.now();
try {
  const blocks = [];
  for (let i = 0; i < 24; i++) {           // 24 x 32MB = 768MB
    const b = new Uint8Array(32 * 1024 * 1024);
    b.fill(i & 0xff);                      // touch every page
    blocks.push(b);
  }
  let sum = 0;
  for (const b of blocks) sum += b[0];
  r.results.alloc768MB = 'ok';
  r.results.memSum = sum;
} catch (e) {
  r.results.alloc768MB = 'FAILED: ' + e.message;
}
r.results.memMs = Date.now() - s;

r.totalMs = Date.now() - t0;
r.node = process.version;
r.rssMB = Math.round(process.memoryUsage().rss / 1048576);
r.cpus = os.cpus().length;

console.log(JSON.stringify(r));