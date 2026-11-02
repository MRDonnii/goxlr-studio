import { test } from 'node:test';
import assert from 'node:assert/strict';
const { occurrences, scheduleStep, lastDue, nextDue } = await import('../public/js/schedule.js');

const at = (d, hm) => new Date(`2026-11-${String(d).padStart(2, '0')}T${hm}:00`).getTime(); // 2 Nov 2026 = Monday
const evening = { id: 'e', at: '22:00', days: [0, 1, 2, 3, 4, 5, 6], actions: ['eq-preset:Sen aften'] };
const morning = { id: 'm', at: '07:00', days: [1, 2, 3, 4, 5], actions: ['hearing-cap:off'] };

test('a rule fires once when its time is passed', () => {
  assert.deepEqual(scheduleStep([evening], at(2, '21:59'), at(2, '22:00')).map((x) => x.rule.id), ['e']);
  assert.equal(scheduleStep([evening], at(2, '22:00'), at(2, '22:01')).length, 0, 'not twice');
  assert.equal(scheduleStep([{ ...evening, actions: [] }], at(2, '21:59'), at(2, '22:00')).length, 0, 'no actions = nothing');
});

test('weekdays and sleep', () => {
  // Saturday 7 Nov: the morning rule is weekdays only.
  assert.equal(occurrences([morning], at(7, '06:00'), at(7, '08:00')).length, 0);
  assert.equal(occurrences([morning], at(9, '06:00'), at(9, '08:00')).length, 1);
  // Asleep from 21:00 to 07:30 the next day: only the latest (the morning) runs.
  assert.deepEqual(scheduleStep([evening, morning], at(2, '21:00'), at(3, '07:30')).map((x) => x.rule.id), ['m']);
});

test('what is in effect now and what comes next', () => {
  assert.equal(lastDue([evening, morning], at(3, '23:00')).rule.id, 'e');
  assert.equal(lastDue([evening, morning], at(4, '12:00')).rule.id, 'm');
  assert.equal(nextDue([evening, morning], at(4, '12:00')).rule.id, 'e');
  assert.equal(lastDue([], at(4, '12:00')), null);
});
