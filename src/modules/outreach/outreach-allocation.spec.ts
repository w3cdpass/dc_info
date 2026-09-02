import { distributeRoundRobin, chunkIntoBursts, allocateOutreach, warmupAllowanceForAge } from './outreach-allocation';

describe('outreach-allocation', () => {
  const contacts = (count: number) => Array.from({ length: count }, (_, i) => ({ phone: `91${9000000000 + i}` }));

  describe('distributeRoundRobin', () => {
    it('balances counts to within one across sessions', () => {
      const sessions = [
        { id: 'a', name: 'a', capacity: 100 },
        { id: 'b', name: 'b', capacity: 100 },
        { id: 'c', name: 'c', capacity: 100 },
      ];
      const by = distributeRoundRobin(contacts(10), sessions);
      expect([...by.values()].map(l => l.length).sort()).toEqual([3, 3, 4]);
    });

    it('caps a session at its capacity and rolls overflow over', () => {
      const sessions = [
        { id: 'a', name: 'a', capacity: 1 },
        { id: 'b', name: 'b', capacity: 100 },
      ];
      const by = distributeRoundRobin(contacts(6), sessions);
      expect(by.get('a')!.length).toBe(1);
      expect(by.get('b')!.length).toBe(5);
    });

    it('does not assign more than total headroom', () => {
      const sessions = [
        { id: 'a', name: 'a', capacity: 2 },
        { id: 'b', name: 'b', capacity: 2 },
      ];
      const by = distributeRoundRobin(contacts(10), sessions);
      const total = [...by.values()].reduce((a, l) => a + l.length, 0);
      expect(total).toBe(4);
    });
  });

  describe('chunkIntoBursts', () => {
    it('splits into bursts of at most burstSize', () => {
      const bursts = chunkIntoBursts(contacts(25), 10);
      expect(bursts.map(b => b.length)).toEqual([10, 10, 5]);
    });

    it('single burst when burstSize <= 0', () => {
      expect(chunkIntoBursts(contacts(7), 0).length).toBe(1);
      expect(chunkIntoBursts([], 5)).toEqual([]);
    });
  });

  describe('allocateOutreach', () => {
    it('round-robins, preserves order, and chunks bursts per session', () => {
      const sessions = [
        { id: 'a', name: 'line-1', capacity: 10 },
        { id: 'b', name: 'line-2', capacity: 10 },
      ];
      const alloc = allocateOutreach(contacts(15), sessions, 5);
      expect(alloc.totalAssigned).toBe(15);
      expect(alloc.unassigned).toEqual([]);
      // 1st, 3rd, 5th... to a; 2nd, 4th, 6th... to b (8 vs 7)
      const a = alloc.sessions.find(s => s.id === 'a')!;
      const b = alloc.sessions.find(s => s.id === 'b')!;
      expect(a.assigned).toBe(8);
      expect(b.assigned).toBe(7);
      // bursts of 5: a -> 2 bursts, b -> 2 bursts
      expect(a.bursts.length).toBe(2);
      expect(b.bursts.length).toBe(2);
      // burst 0 of a is the 1st, 3rd, 5th, 7th, 9th contacts
      expect(a.bursts[0].contacts.map(c => c.phone)).toEqual([0, 2, 4, 6, 8].map(i => contacts(15)[i].phone));
    });

    it('reports unassigned when capacity is exhausted', () => {
      const sessions = [
        { id: 'a', name: 'line-1', capacity: 2 },
        { id: 'b', name: 'line-2', capacity: 2 },
      ];
      const alloc = allocateOutreach(contacts(10), sessions, 5);
      expect(alloc.totalAssigned).toBe(4);
      expect(alloc.unassigned.length).toBe(6);
      expect(alloc.sessions.every(s => s.assigned === s.capacity)).toBe(true);
    });
  });

  describe('warmupAllowanceForAge', () => {
    const schedule = [20, 40, 80, 160, 320, 640, 1000];

    it('blamps age to schedule bounds', () => {
      expect(warmupAllowanceForAge(schedule, 0)).toBe(20);
      expect(warmupAllowanceForAge(schedule, 1)).toBe(40);
      expect(warmupAllowanceForAge(schedule, 6)).toBe(1000);
      expect(warmupAllowanceForAge(schedule, 30)).toBe(1000);
      expect(warmupAllowanceForAge(schedule, -1)).toBe(20);
    });

    it('Infinity for empty schedule', () => {
      expect(warmupAllowanceForAge([], 5)).toBe(Infinity);
    });
  });
});
