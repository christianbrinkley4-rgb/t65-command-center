// Run with: node scripts/test-queue.cjs. No database writes or phone calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  mod._compile(js, filename);
};
const { isKnockableLead, mailerBatches } = require('../src/lib/knockSelection.ts');
const tag = 'kernersville-mailers-2026-09-11';
const base = { id: 'test', address: '123 Example St', status: 'New', stage_bucket: 'New Prospecting', tags: [tag], do_not_knock: false };
for (const status of ['Closed - Bad Number', 'Closed - DNC', 'Wrong Number']) {
  assert.equal(isKnockableLead({ ...base, status, stage_bucket: 'Closed' }), true, status + ' still has a usable door');
}
for (const status of ['Closed - Merged', 'Closed - Sold', 'Closed - Not Interested', 'Deceased']) {
  assert.equal(isKnockableLead({ ...base, status }), false, status + ' stays out');
}
assert.equal(isKnockableLead({ ...base, do_not_knock: true }), false);
assert.equal(isKnockableLead({ ...base, address: ' ' }), false);
assert.equal(isKnockableLead({ ...base, status: 'Needs Info', stage_bucket: 'Needs Info' }), false);
const leads = Array.from({ length: 30 }, (_, i) => ({ ...base, id: String(i), status: i < 10 ? 'Closed - Bad Number' : 'New', stage_bucket: i < 10 ? 'Closed' : 'New Prospecting' }));
const batches = mailerBatches(leads);
assert.deepEqual(batches, [{ tag, label: 'Kernersville mailers', sent: '2026-09-11', count: 30 }]);
assert.equal(mailerBatches([{ ...base, tags: [tag, tag] }])[0].count, 1);
assert.equal(mailerBatches([{ ...base, tags: ['unrelated'] }]).length, 0);
assert.equal(mailerBatches([{ ...base, do_not_knock: true }]).length, 0);
console.log('14 door eligibility and mailer batch assertions passed');
