// Run with: node scripts/test-queue.cjs. No database writes or phone calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  mod._compile(js, filename);
};
const { buildQueue, buildDialQueue, nextDialIndex } = require('../src/lib/priority.ts');
const { withBuckets } = require('../src/lib/buckets.ts');
const { leadPhones, otherLeadPhone } = require('../src/lib/phone.ts');
const { deftSalesCsv } = require('../src/lib/csv.ts');
const base = { id: 'test', name: 'Example Lead', phone: '(336) 555-1001', phone2: '336-555-1002', status: 'New', stage_bucket: 'New Prospecting', do_not_call: false, _bucket: 'New', birthday: null, created_at: '2020-01-01', dials_count: 0, next_follow_up_date: null, tags: [] };
const dnc = { ...base, do_not_call: true, _dncSuppressed: true };
assert.equal(buildQueue([dnc]).length, 1, 'DNC flags do not remove a lead');
const closedDnc = withBuckets([{ ...dnc, status: 'Closed - DNC', stage_bucket: 'Closed' }])[0];
assert.equal(buildQueue([closedDnc]).length, 1, 'DNC status does not remove a lead');
assert.equal(buildQueue([{ ...closedDnc, _bucket: 'Closed' }]).length, 1, 'Legacy Closed bucket does not hide DNC');
for (const status of ['Closed - Merged', 'Closed - Bad Number', 'Closed - Not Interested']) {
  assert.equal(buildQueue(withBuckets([{ ...base, status }])).length, 0, status + ' retains its existing handling');
}
assert.equal(buildQueue([{ ...dnc, appointment_datetime: '2099-01-01T12:00:00Z' }]).length, 0, 'Appointment hold still works');
assert.equal(buildQueue([{ ...base, _dncSuppressed: true }]).length, 1, 'Shared DNC number stays in queue');
const entries = buildDialQueue([dnc, { ...base, id: 'other', phone: '3365551003', phone2: null }]);
assert.deepEqual(entries.map(x => x._queuePhone), ['+13365551001', '+13365551002', '+13365551003']);
assert.equal(new Set(entries.map(x => x._queueKey)).size, 3, 'Phone entries have distinct keys');
assert.equal(nextDialIndex(entries, 0), 1, 'No answer advances to the second phone');
assert.equal(nextDialIndex(entries, 0, true), 2, 'Finished conversation advances to the next person');
assert.equal(nextDialIndex(entries, 1), 2);
assert.deepEqual(leadPhones({ phone: 'DNC', phone2: '3365551002' }), ['+13365551002']);
assert.deepEqual(leadPhones({ phone: '(336)555-1001', phone2: '+13365551001' }), ['+13365551001']);
const exported = deftSalesCsv([dnc]);
assert.equal(exported.rows, 2, 'Both DNC numbers are exported');
assert.ok(exported.csv.includes('+13365551001'));
assert.ok(exported.csv.includes('+13365551002'));
assert.equal(deftSalesCsv([dnc, dnc]).rows, 2, 'Export dedupes actual duplicate phones');
assert.equal(deftSalesCsv([{ ...dnc, phone: 'DNC', phone2: '3365551002' }]).rows, 1);
assert.equal(otherLeadPhone(dnc, '+13365551001'), '+13365551002');
assert.equal(otherLeadPhone(dnc, '+13365551002'), '+13365551001');
console.log('22 queue/phone/export regression assertions passed');
