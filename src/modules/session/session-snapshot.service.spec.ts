import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionSnapshotService } from './session-snapshot.service';
import type { SessionService } from './session.service';
import type { EngineFactory } from '../../engine/engine.factory';
import { SessionStatus, Session } from './entities/session.entity';

const configService = (root: string) =>
  ({ get: (key: string): unknown => (key === 'engine.sessionSnapshotPath' ? root : undefined) }) as ConfigService;

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 'sess-1',
    name: 'line-1',
    status: SessionStatus.READY,
    phone: '917717574707',
    pushName: 'Infyle Technologies',
    config: {},
    proxyUrl: null,
    proxyType: null,
    connectedAt: null,
    lastActiveAt: null,
    nodeId: null,
    claimedAt: null,
    nodeUrl: null,
    leaseExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Session;

const makeEngineFactory = (wwjsRoot: string, baileysRoot: string): EngineFactory =>
  ({
    wwjsAuthDirPath: (name: string) => path.join(wwjsRoot, `session-${name}`),
    baileysAuthDirPath: (name: string) => path.join(baileysRoot, name),
  }) as unknown as EngineFactory;

const makeSessionService = () => {
  const created: Array<{ name: string }> = [];
  const create = jest.fn(async (dto: { name: string }): Promise<Session> => {
    if (created.some(c => c.name === dto.name)) {
      throw new ConflictException(`Session with name '${dto.name}' already exists`);
    }
    created.push({ name: dto.name });
    const session = makeSession({ name: dto.name, id: `uuid-${created.length}`, status: SessionStatus.CREATED });
    return session;
  });
  const deleteFn = jest.fn(async () => undefined);
  return { service: { create, delete: deleteFn } as unknown as SessionService, created };
};

describe('SessionSnapshotService (integrated against a temp dir)', () => {
  let tmp: string;
  let snapshotRoot: string;
  let wwjsRoot: string;
  let baileysRoot: string;
  let service: SessionSnapshotService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-snap-'));
    snapshotRoot = path.join(tmp, 'snapshots');
    wwjsRoot = path.join(tmp, 'sessions');
    baileysRoot = path.join(tmp, 'baileys');
    fs.mkdirSync(wwjsRoot, { recursive: true });
    fs.mkdirSync(baileysRoot, { recursive: true });
    service = new SessionSnapshotService(
      configService(snapshotRoot),
      makeEngineFactory(wwjsRoot, baileysRoot),
      makeSessionService().service,
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Seed an engine credential dir for `sessionName` with a marker file. */
  const seed = (root: string, dirName: string) => {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ a: 1 }));
    return dir;
  };

  describe('export', () => {
    it('captures the whatsapp-web.js credential dir into a labelled snapshot', async () => {
      seed(wwjsRoot, 'session-line-1');
      const session = makeSession();
      const out = await service.export(session, { name: 'line-1-2026' });

      expect(out.name).toBe('line-1-2026');
      expect(out.engines).toContain('whatsapp-web.js');
      expect(out.phone).toBe('917717574707');
      expect(out.sourceSessionName).toBe('line-1');
      // The copied creds exist under the snapshot.
      expect(fs.existsSync(path.join(snapshotRoot, 'line-1-2026', 'whatsapp-web.js', 'creds.json'))).toBe(true);
    });

    it('captures both engine shapes when both exist', async () => {
      seed(wwjsRoot, 'session-line-1');
      seed(baileysRoot, 'line-1');
      const out = await service.export(makeSession(), { name: 'both' });
      expect(out.engines.sort()).toEqual(['baileys', 'whatsapp-web.js']);
    });

    it('refuses a duplicate snapshot name', async () => {
      seed(wwjsRoot, 'session-line-1');
      await service.export(makeSession(), { name: 'dup' });
      await expect(service.export(makeSession(), { name: 'dup' })).rejects.toThrow(ConflictException);
    });

    it('reports an empty engines list when no credential dir exists', async () => {
      const out = await service.export(makeSession(), { name: 'empty' });
      expect(out.engines).toEqual([]);
    });
  });

  describe('restore', () => {
    it('creates a new session seeded from the snapshot (reconnect without QR)', async () => {
      seed(wwjsRoot, 'session-line-1');
      const exported = await service.export(makeSession(), { name: 'src' });
      expect(exported.engines).toContain('whatsapp-web.js');

      const created = await service.restore({ name: 'src', newSessionName: 'line-1-copy' });
      expect(created.name).toBe('line-1-copy');
      // The new session's wwjs credential dir is seeded with the snapshot contents.
      expect(fs.existsSync(path.join(wwjsRoot, 'session-line-1-copy', 'creds.json'))).toBe(true);
      // Snapshot manifest now records the restore.
      const manifest = JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'src', 'snapshot.json'), 'utf8'));
      expect(manifest.restoredInto).toContain('line-1-copy');
    });

    it('throws when the snapshot does not exist', async () => {
      await expect(service.restore({ name: 'nope', newSessionName: 'line-9' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove + list', () => {
    it('lists snapshots newest-first with size metadata', async () => {
      seed(wwjsRoot, 'session-line-1');
      await service.export(makeSession(), { name: 'a' });
      await service.export(makeSession(), { name: 'b' });
      const listed = await service.list();
      expect(listed).toHaveLength(2);
      expect(listed.map(s => s.name).sort()).toEqual(['a', 'b']);
      expect(listed.every(s => s.sizeBytes > 0 && s.fileCount >= 1)).toBe(true);
    });

    it('deletes a snapshot', async () => {
      seed(wwjsRoot, 'session-line-1');
      await service.export(makeSession(), { name: 'gone' });
      const res = await service.remove('gone');
      expect(res.deleted).toBe(true);
      expect(fs.existsSync(path.join(snapshotRoot, 'gone'))).toBe(false);
      expect((await service.list()).length).toBe(0);
    });
  });
});
