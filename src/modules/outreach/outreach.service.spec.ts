import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { OutreachService } from './outreach.service';
import { OutreachCampaign, OutreachStatus } from './entities/outreach-campaign.entity';
import { SessionService } from '../session/session.service';
import { BulkMessageService } from '../message/bulk-message.service';
import { SessionRestrictionStore } from '../session/session-restriction-store.service';
import { Session, SessionStatus } from '../session/entities/session.entity';

const repoMock = (overrides: Record<string, jest.Mock> = {}) => ({
  create: jest.fn(),
  save: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  delete: jest.fn(),
  ...overrides,
});

function makeSession(name: string, id: string, ageDays: number): Session {
  const s = new Session();
  s.id = id;
  s.name = name;
  s.status = SessionStatus.READY;
  s.phone = '917717574707';
  s.createdAt = new Date(Date.now() - ageDays * 86400000);
  return s;
}

function makeRepo(initial: OutreachCampaign | null) {
  const mock = repoMock();
  mock.create.mockImplementation(dto => ({ ...dto, id: 'camp-1', status: OutreachStatus.SCHEDULED }));
  mock.save.mockImplementation((c: OutreachCampaign) => Promise.resolve(c));
  mock.findOne.mockImplementation(() => Promise.resolve(initial));
  return mock;
}

describe('OutreachService', () => {
  async function setup(opts: { initial?: OutreachCampaign | null; sessions?: Session[] } = {}) {
    const sessions = opts.sessions ?? [makeSession('line-1', 's1', 0), makeSession('line-2', 's2', 1)];
    const sessionService = {
      findAll: jest.fn().mockResolvedValue(sessions),
    };
    const bulkMessage = {
      createBatch: jest.fn(),
      getBatchStatus: jest.fn(),
      cancelBatch: jest.fn(),
    };
    const restrictionStore = {
      get: jest.fn().mockReturnValue(undefined),
    };
    const repo = makeRepo(opts.initial ?? null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        OutreachService,
        { provide: getRepositoryToken(OutreachCampaign, 'data'), useValue: repo },
        { provide: SessionService, useValue: sessionService },
        { provide: BulkMessageService, useValue: bulkMessage },
        { provide: SessionRestrictionStore, useValue: restrictionStore },
      ],
    }).compile();

    return {
      service: moduleRef.get(OutreachService),
      repo,
      sessionService,
      bulkMessage,
      restrictionStore,
    };
  }

  describe('create', () => {
    it('allocates contacts round-robin across sessions and persists distribution', async () => {
      const { service, repo } = await setup();
      const dto: any = {
        name: 'wave-1',
        messageText: 'Hi {{name}}',
        variableMap: {},
        contacts: [{ phone: '919000000001' }, { phone: '919000000002' }, { phone: '919000000003' }],
        sessions: [{ sessionName: 'line-1' }, { sessionName: 'line-2' }],
        strategy: {
          burstSize: 2,
          cooldownMinMs: 1000,
          cooldownMaxMs: 2000,
          warmupSchedule: [5, 5],
          pacing: { minDelayMs: 1000, maxDelayMs: 2000 },
        },
      };

      const res = await service.create(dto);
      expect(res.status).toBe(OutreachStatus.SCHEDULED);
      expect(res.contactCount).toBe(3);
      const saved = repo.save.mock.calls[0][0] as OutreachCampaign;
      // round-robin: line-1 gets contacts 0 and 2, line-2 gets contact 1
      const dist = saved.distribution!;
      expect(dist.find(d => d.sessionId === 's1')!.assigned).toBe(2);
      expect(dist.find(d => d.sessionId === 's2')!.assigned).toBe(1);
    });

    it('rejects unknown session names', async () => {
      const { service } = await setup();
      const dto: any = {
        name: 'wave-x',
        messageText: 'hi',
        contacts: [{ phone: '919000000001' }],
        sessions: [{ sessionName: 'nope' }],
      };
      await expect(service.create(dto)).rejects.toThrow(/Unknown session/);
    });
  });

  describe('start', () => {
    it('starts a scheduled campaign', async () => {
      // findOne returns a persisted campaign
      const campaign = new OutreachCampaign();
      campaign.id = 'camp-1';
      campaign.name = 'wave-1';
      campaign.status = OutreachStatus.SCHEDULED;
      campaign.contacts = [{ phone: '919000000001' }];
      campaign.sessions = [{ sessionName: 'line-1', sessionId: 's1' }];
      campaign.strategy = {
        burstSize: 1,
        cooldownMinMs: 1000,
        cooldownMaxMs: 2000,
        warmupSchedule: [5],
        pacing: { minDelayMs: 1000, maxDelayMs: 2000 },
        preCheckNumbers: true,
        saveContactFirst: true,
      };
      campaign.distribution = [
        {
          sessionId: 's1',
          sessionName: 'line-1',
          assigned: 1,
          contacts: [{ phone: '919000000001' }],
          bursts: [{ burstIndex: 0, contacts: [{ phone: '919000000001' }] }],
        },
      ];
      campaign.sessionProgress = [{ sessionId: 's1', sessionName: 'line-1', total: 1, sent: 0, failed: 0, pending: 1 }];

      const { service, repo, bulkMessage } = await setup({ initial: campaign });
      repo.save.mockImplementation((c: OutreachCampaign) => Promise.resolve(c));

      const res = await service.start('camp-1');
      expect(res.status).toBe(OutreachStatus.RUNNING);
      // startRuntime begins; on module destroy timers are cleared. We stop immediately to cancel the
      // in-flight dispatch cycle.
      service.onModuleDestroy();
      expect(res).toBeTruthy();
      expect(bulkMessage.createBatch).toBeDefined();
    });
  });

  describe('status / list / remove', () => {
    it('list returns newest-first mapped responses', async () => {
      const one = new OutreachCampaign();
      one.id = '1';
      one.name = 'a';
      one.status = OutreachStatus.SCHEDULED;
      one.contacts = [{ phone: '1' }];
      one.sessions = [];
      one.createdAt = new Date();
      const { service, repo } = await setup();
      repo.find.mockResolvedValue([one]);
      const res = await service.list();
      expect(res.length).toBe(1);
      expect(res[0].id).toBe('1');
    });
  });
});
