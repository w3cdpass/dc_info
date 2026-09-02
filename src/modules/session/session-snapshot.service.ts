/* eslint-disable @typescript-eslint/require-await */
import { Injectable, NotFoundException, ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { EngineFactory } from '../../engine/engine.factory';
import { SessionService } from './session.service';
import { Session } from './entities/session.entity';
import { isSafeSessionName } from '../../common/utils/path-safety';
import { ensurePrivateDir } from '../../common/utils/private-dir.util';
import { createLogger } from '../../common/services/logger.service';
import {
  CreateSessionSnapshotDto,
  RestoreSessionSnapshotDto,
  SessionSnapshotResponseDto,
  DeleteSessionSnapshotResponseDto,
} from './dto/session-snapshot.dto';

/** Serialised metadata written into each snapshot dir (snapshot.json). */
interface SnapshotManifest {
  name: string;
  sourceSessionName: string;
  sourceSessionId: string;
  phone: string | null;
  pushName: string | null;
  engines: string[];
  createdAt: string;
  restoredInto: string[];
}

const WWJS_KEY = 'whatsapp-web.js';
const BAILEYS_KEY = 'baileys';
const MANIFEST_FILENAME = 'snapshot.json';

/**
 * Backup / restore of a session's on-disk WhatsApp credentials (the "isolated web client" save).
 *
 * Each OpenWA session already persists its paired credentials on the filesystem, keyed by session
 * NAME: whatsapp-web.js under `session-<name>` (SessionDataPath), Baileys under `<name>`
 * (BaileysAuthDir), and any surviving dir reconnects WITHOUT a fresh QR scan. This service gives the
 * operator an explicit, labelled snapshot of those credentials so a connected web client can be:
 *
 *  - **saved** (`export`): copy the source session's credential dir(s) into a labelled snapshot;
 *  - **restored** (`restore`): create a brand-new isolated session and seed its credential dir(s)
 *    from a snapshot, so starting it reconnects to the same WhatsApp account without re-scanning QR.
 *
 * Snapshot layout under the snapshot root:
 *   <root>/<snapshot>/snapshot.json
 *   <root>/<snapshot>/wwjs/      (copy of the source `session-<name>` dir, if present)
 *   <root>/<snapshot>/baileys/   (copy of the source `<name>` dir, if present)
 *
 * Both engine shapes are captured (not just the active engine's): a session that ever ran under both
 * engines leaves a live dir for each, and a snapshot should let the operator restore under whichever
 * ENGINE_TYPE they deploy next. Each copy is best-effort — a snapshot with no surviving credential
 * dir is still created, but reported with an empty `engines` list so the gap is visible.
 */
@Injectable()
export class SessionSnapshotService {
  private readonly logger = createLogger('SessionSnapshotService');
  private readonly root: string;

  constructor(
    configService: ConfigService,
    private readonly engineFactory: EngineFactory,
    private readonly sessionService: SessionService,
  ) {
    this.root = configService.get<string>('engine.sessionSnapshotPath') ?? './data/session-snapshots';
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  /** Every stored snapshot, with its manifest, newest first. */
  async list(): Promise<SessionSnapshotResponseDto[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.root);
    } catch {
      if (!fs.existsSync(this.root)) return [];
      throw new HttpException('Could not read snapshot directory', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const out: SessionSnapshotResponseDto[] = [];
    for (const entry of entries) {
      // Only dirs (a stray file in the root is not a snapshot); skip anything whose name we cannot
      // safely map back to a dir key, mirroring the DTO's charset.
      if (!isSafeSessionName(entry)) continue;
      const dir = path.join(this.root, entry);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const manifest = await this.readManifest(entry);
      if (!manifest) continue; // no manifest -> not one of our snapshots
      out.push(await this.describe(entry, manifest));
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Export (save a connected client)
  // ---------------------------------------------------------------------------

  /**
   * Copy a session's credential dir(s) into a labelled snapshot. Requires an existing session (id or
   * name is not used directly — the controller resolves the session and passes what we need).
   */
  async export(session: Session, dto: CreateSessionSnapshotDto): Promise<SessionSnapshotResponseDto> {
    this.assertSafeName(dto.name, 'Snapshot');
    const destDir = path.join(this.root, dto.name);
    if (fs.existsSync(destDir)) {
      throw new ConflictException(`Snapshot '${dto.name}' already exists; pick another name or delete it first`);
    }
    ensurePrivateDir(this.root);
    ensurePrivateDir(destDir);

    const engines: string[] = [];
    const present = await this.copyExistingEngineDirs(session.name, destDir);
    engines.push(...present);

    const manifest: SnapshotManifest = {
      name: dto.name,
      sourceSessionName: session.name,
      sourceSessionId: session.id,
      phone: session.phone ?? null,
      pushName: session.pushName ?? null,
      engines,
      createdAt: new Date().toISOString(),
      restoredInto: [],
    };
    await this.writeManifest(destDir, manifest);

    this.logger.log(`Captured auth snapshot '${dto.name}' from session '${session.name}'`, {
      action: 'snapshot_export',
      snapshot: dto.name,
      sessionName: session.name,
      engines,
    });
    return this.describe(dto.name, manifest);
  }

  // ---------------------------------------------------------------------------
  // Restore (recreate an isolated client from a saved snapshot)
  // ---------------------------------------------------------------------------

  /**
   * Create a brand-new isolated session whose credential dir(s) are seeded from the named snapshot,
   * so the new session reconnects to the saved WhatsApp account without a fresh QR scan.
   */
  async restore(dto: RestoreSessionSnapshotDto): Promise<Session> {
    this.assertSafeName(dto.name, 'Snapshot');
    this.assertSafeName(dto.newSessionName, 'Session');

    const srcDir = path.join(this.root, dto.name);
    const manifest = await this.readManifestOrThrow(dto.name);
    if (!fs.existsSync(srcDir)) {
      throw new NotFoundException(`Snapshot '${dto.name}' not found`);
    }

    // Create the session row first (reuses existence checks + conflict handling). Any name collision
    // surfaces as a 409 before any credential directory is seeded.
    const session = await this.sessionService.create({ name: dto.newSessionName });

    try {
      for (const engine of manifest.engines) {
        const from = path.join(srcDir, engine);
        const to =
          engine === WWJS_KEY
            ? this.engineFactory.wwjsAuthDirPath(dto.newSessionName)
            : this.engineFactory.baileysAuthDirPath(dto.newSessionName);
        this.copyTree(from, to);
      }
      manifest.restoredInto = [...(manifest.restoredInto ?? []), dto.newSessionName];
      await this.writeManifest(srcDir, manifest);
    } catch (error) {
      // The session row exists but the credential seed failed — roll back the row so the operator's
      // only leftover is a normal empty session they can delete, not a half-seeded account clone.
      await this.sessionService.delete(session.id).catch(() => undefined);
      throw error;
    }

    this.logger.log(`Restored auth snapshot '${dto.name}' into new session '${dto.newSessionName}'`, {
      action: 'snapshot_restore',
      snapshot: dto.name,
      sessionName: dto.newSessionName,
      engines: manifest.engines,
    });
    return session;
  }

  // ---------------------------------------------------------------------------
  // Remove
  // ---------------------------------------------------------------------------

  async remove(name: string): Promise<DeleteSessionSnapshotResponseDto> {
    this.assertSafeName(name, 'Snapshot');
    const dir = path.join(this.root, name);
    if (!fs.existsSync(dir)) {
      throw new NotFoundException(`Snapshot '${name}' not found`);
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
    this.logger.log(`Deleted auth snapshot '${name}'`, { action: 'snapshot_delete', snapshot: name });
    return { name, deleted: true };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Copy which of a session's engine credential dirs actually exist on disk. Returns engine keys copied. */
  private async copyExistingEngineDirs(sessionName: string, destDir: string): Promise<string[]> {
    const sources: Array<{ key: string; dir: string }> = [
      { key: WWJS_KEY, dir: this.engineFactory.wwjsAuthDirPath(sessionName) },
      { key: BAILEYS_KEY, dir: this.engineFactory.baileysAuthDirPath(sessionName) },
    ];
    const copied: string[] = [];
    for (const { key, dir } of sources) {
      if (!fs.existsSync(dir)) continue;
      const to = path.join(destDir, key);
      try {
        this.copyTree(dir, to);
        copied.push(key);
      } catch (error) {
        this.logger.warn(`Failed to snapshot ${key} credentials for session '${sessionName}'`, {
          action: 'snapshot_export_partial',
          engine: key,
          sessionName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return copied;
  }

  /** Recursive copy of one directory into another (creating parents). */
  private copyTree(from: string, to: string): void {
    ensurePrivateDir(to);
    fs.cpSync(from, to, { recursive: true, force: true });
  }

  private async readManifest(name: string): Promise<SnapshotManifest | null> {
    const file = path.join(this.root, name, MANIFEST_FILENAME);
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      return JSON.parse(raw) as SnapshotManifest;
    } catch {
      return null;
    }
  }

  private async readManifestOrThrow(name: string): Promise<SnapshotManifest> {
    const manifest = await this.readManifest(name);
    if (!manifest) {
      throw new NotFoundException(`Snapshot '${name}' not found or has no metadata`);
    }
    return manifest;
  }

  private async writeManifest(dir: string, manifest: SnapshotManifest): Promise<void> {
    ensurePrivateDir(dir);
    await fs.promises.writeFile(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');
  }

  private async describe(name: string, manifest: SnapshotManifest): Promise<SessionSnapshotResponseDto> {
    const dir = path.join(this.root, name);
    const { sizeBytes, fileCount } = await this.measure(dir);
    return {
      name,
      sourceSessionName: manifest.sourceSessionName,
      engines: manifest.engines ?? [],
      phone: manifest.phone ?? null,
      createdAt: new Date(manifest.createdAt),
      sizeBytes,
      fileCount,
      restoredInto: manifest.restoredInto ?? [],
    };
  }

  private async measure(dir: string): Promise<{ sizeBytes: number; fileCount: number }> {
    let sizeBytes = 0;
    let fileCount = 0;
    const walk = async (current: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          fileCount++;
          try {
            const st = await fs.promises.stat(full);
            sizeBytes += st.size;
          } catch {
            /* skip unreadable file */
          }
        }
      }
    };
    await walk(dir);
    return { sizeBytes, fileCount };
  }

  private assertSafeName(name: string, kind: 'Snapshot' | 'Session'): void {
    if (!isSafeSessionName(name)) {
      throw new HttpException(`${kind} name can only contain letters, numbers, and hyphens`, HttpStatus.BAD_REQUEST);
    }
  }
}
