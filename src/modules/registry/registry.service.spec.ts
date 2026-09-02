import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { RegistryService } from './registry.service';
import { RegistryContact } from './entities/registry-contact.entity';
import { RegistryBlocked, BlockKind } from './entities/registry-blocked.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { ContactService } from '../contact/contact.service';
import { SessionService } from '../session/session.service';

const repoMock = (overrides: Record<string, jest.Mock> = {}) => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneBy: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
  ...overrides,
});

function makeSession(name: string, id: string, status = SessionStatus.READY): Session {
  const s = new Session();
  s.id = id;
  s.name = name;
  s.status = status;
  return s;
}

describe('RegistryService', () => {
  async function setup(
    overrides: {
      existingContacts?: RegistryContact[];
      incoming?: Message[];
      sessions?: Session[];
    } = {},
  ) {
    const existingContacts = overrides.existingContacts ?? [];
    const sessions = overrides.sessions ?? [makeSession('line-1', 's1')];

    const contactsRepo = {
      ...repoMock(),
      find: jest.fn().mockResolvedValue(existingContacts),
      findOneBy: jest.fn().mockResolvedValue(undefined),
      save: jest.fn((c: RegistryContact) => {
        c.id = c.id ?? 'c-' + c.phone;
        return Promise.resolve(c);
      }),
      create: jest.fn((meta: Partial<RegistryContact>) => meta as RegistryContact),
    };
    const blockedRepo = repoMock();
    blockedRepo.find.mockResolvedValue([]);
    blockedRepo.findOneBy.mockResolvedValue(undefined);
    blockedRepo.count.mockResolvedValue(0);
    blockedRepo.create.mockImplementation((m: Partial<RegistryBlocked>) => ({ id: 'b', ...m }));
    blockedRepo.save.mockImplementation((b: RegistryBlocked) => Promise.resolve(b));
    blockedRepo.delete.mockResolvedValue({ affected: 1 });

    const messagesRepo = repoMock();
    messagesRepo.find.mockResolvedValue(overrides.incoming ?? []);
    messagesRepo.count.mockResolvedValue(0);

    const sessionsRepo = {
      ...repoMock(),
      find: jest.fn().mockResolvedValue(sessions),
    };

    const contactService = {
      getContacts: jest.fn().mockResolvedValue([]),
      getBlockedContacts: jest.fn().mockResolvedValue([]),
      upsertContact: jest.fn().mockResolvedValue(undefined),
    };
    const sessionService = {} as SessionService;

    const moduleRef = await Test.createTestingModule({
      providers: [
        RegistryService,
        { provide: getRepositoryToken(RegistryContact, 'data'), useValue: contactsRepo },
        { provide: getRepositoryToken(RegistryBlocked, 'data'), useValue: blockedRepo },
        { provide: getRepositoryToken(Message, 'data'), useValue: messagesRepo },
        { provide: getRepositoryToken(Session, 'data'), useValue: sessionsRepo },
        { provide: ContactService, useValue: contactService },
        { provide: SessionService, useValue: sessionService },
      ],
    }).compile();

    return {
      service: moduleRef.get(RegistryService),
      contactsRepo,
      blockedRepo,
      messagesRepo,
      sessionsRepo,
      contactService,
    };
  }

  it('normalizes phones and dedupes within the submission', async () => {
    const { service, contactsRepo } = await setup();
    contactsRepo.find.mockResolvedValue([]);
    const res = await service.importContacts({
      items: [
        { phone: '+62 812-3456-789' },
        { phone: '628123456789' }, // same normalized number -> collapsed
        { phone: 'not-a-number!' }, // invalid -> dropped
      ],
    });
    expect(res.total).toBe(1);
    expect(res.invalid).toBe(1);
    expect(res.added).toBe(1);
    expect(res.addedPhones).toEqual(['628123456789']);
  });

  it('never double-saves a number already in the local registry', async () => {
    const existing = new RegistryContact();
    existing.phone = '628111111111';
    const { service, contactsRepo } = await setup({ existingContacts: [existing] });

    const res = await service.importContacts({
      items: [{ phone: '628111111111' }, { phone: '628222222222' }],
    });
    expect(res.added).toBe(1);
    expect(res.duplicatesLocal).toBe(1);
    expect(contactsRepo.save).toHaveBeenCalledTimes(1);
  });

  it('optionally skips numbers already in the WhatsApp addressbook', async () => {
    const { service, contactService, contactsRepo } = await setup();
    contactsRepo.find.mockResolvedValue([]);
    contactService.getContacts.mockResolvedValue([{ number: '628333333333' }]);

    const res = await service.importContacts({
      items: [{ phone: '628333333333' }, { phone: '628444444444' }],
      checkWhatsAppAddressbook: true,
    });
    expect(res.duplicatesWhatsApp).toBe(1);
    expect(res.added).toBe(1);
    expect(res.addedPhones).toEqual(['628444444444']);
  });

  it('mirror-saves new numbers into the WhatsApp addressbook of a ready session', async () => {
    const { service, contactService, contactsRepo } = await setup();
    contactsRepo.find.mockResolvedValue([]);
    contactsRepo.findOneBy.mockResolvedValue(null);

    const res = await service.importContacts({
      items: [{ phone: '628555555555' }],
      saveToWhatsApp: true,
    });
    expect(res.added).toBe(1);
    expect(contactService.upsertContact).toHaveBeenCalledTimes(1);
    expect(contactService.upsertContact.mock.calls[0][1]).toBe('628555555555@c.us');
  });

  it('annotates contacts with reply status from persisted incoming messages', async () => {
    const existing = new RegistryContact();
    existing.id = 'a';
    existing.phone = '628111111111';
    const another = new RegistryContact();
    another.id = 'b';
    another.phone = '628222222222';

    const inc = new Message();
    inc.sessionId = 's1';
    inc.chatId = '628111111111@c.us';
    inc.direction = MessageDirection.INCOMING;
    inc.timestamp = 1700000000;

    const { service, messagesRepo } = await setup({
      existingContacts: [existing, another],
      incoming: [inc],
    });
    messagesRepo.find.mockResolvedValue([inc]);

    const list = await service.listContacts();
    const byPhone = new Map(list.map(c => [c.phone, c]));
    expect(byPhone.get('628111111111')!.replied).toBe(true);
    expect(byPhone.get('628111111111')!.incomingCount).toBe(1);
    expect(byPhone.get('628222222222')!.replied).toBe(false);
  });

  it('records and lists blocked/reported entries, deduped by phone+kind', async () => {
    const { service, blockedRepo } = await setup();
    const created: RegistryBlocked[] = [];
    blockedRepo.save.mockImplementation((b: RegistryBlocked) => {
      const existing = created.find(c => c.id === b.id);
      if (existing) return Promise.resolve(existing);
      b.id = String(created.length + 1);
      created.push(b);
      return Promise.resolve(b);
    });
    blockedRepo.findOneBy.mockImplementation((q: { phone: string; kind: BlockKind }) =>
      Promise.resolve(created.find(c => c.phone === q.phone && c.kind === q.kind) ?? undefined),
    );
    blockedRepo.find.mockImplementation(() => Promise.resolve([...created]));

    await service.recordBlocked({ phone: '628666666666', kind: 'reported' });
    const second = await service.recordBlocked({ phone: '628666666666', kind: 'reported', sessionName: 'line-1' });
    expect(second.kind).toBe('reported');

    const list = await service.listBlocked(false);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].kind).toBe('reported');
    expect(list.items[0].sessionName).toBe('line-1');
  });

  it('removes a blocked/reported entry', async () => {
    const { service, blockedRepo } = await setup();
    blockedRepo.delete.mockResolvedValue({ affected: 1 });
    const res = await service.removeBlocked('628666666666', 'reported');
    expect(res.removed).toBe(true);
    expect(blockedRepo.delete).toHaveBeenCalledWith({ phone: '628666666666', kind: BlockKind.REPORTED });
  });
});
