// WER per clip and engine against <clip>.ref.txt, after light normalization
// (case, punctuation, Arabic diacritics, alef/ya/ta-marbuta variants). Prints word-level diffs.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const [media, ...clips] = process.argv.slice(2);
const engines = [...new Set(readdirSync(media + '/out').map(f => f.match(/^[^.]+\.(.+)\.txt$/)?.[1]).filter(Boolean))].sort();
const norm = (s) => s.toLowerCase()
  .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
function align(r, h) {
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (r[i-1] === h[j-1] ? 0 : 1));
  const ops = []; let i = r.length, j = h.length;
  while (i || j) {
    if (i && j && d[i][j] === d[i-1][j-1] + (r[i-1] === h[j-1] ? 0 : 1)) { if (r[i-1] !== h[j-1]) ops.push(`${r[i-1]} → ${h[j-1]}`); i--; j--; }
    else if (i && d[i][j] === d[i-1][j] + 1) { ops.push(`-${r[i-1]}`); i--; }
    else { ops.push(`+${h[j-1]}`); j--; }
  }
  return { wer: d[r.length][h.length] / r.length, ops: ops.reverse() };
}
for (const clip of clips) {
  const ref = norm(readFileSync(`${media}/${clip}.ref.txt`, 'utf8'));
  for (const e of engines) {
    const f = `${media}/out/${clip}.${e}.txt`; if (!existsSync(f)) continue;
    const { wer, ops } = align(ref, norm(readFileSync(f, 'utf8')));
    console.log(`\n## ${clip} ${e}  WER ${(wer * 100).toFixed(1)}%  (${ref.length} ref words)`);
    console.log(ops.join(' | '));
  }
}
