import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { RegistryContact } from './entities/registry-contact.entity';
import { RegistryBlocked, BlockKind } from './entities/registry-blocked.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { ContactService } from '../contact/contact.service';
import { SessionService } from '../session/session.service';
import {
  ImportContactsDto,
  ImportContactsResultDto,
  RegistryContactDto,
  RegistryBlockedDto,
  SessionReplyStatsDto,
} from './dto/registry.dto';

const NEUTRAL_SUFFIX = '@c.us';

/** Strip non-digits and drop a trailing @c.us / @s.whatsapp.net / bare-country punch. */
function normalizePhone(raw: string): string | null {
  const digits = String(raw).replace(/\D/g, '');
  // WhatsApp numbers are 5-15 digits (a bare 5-digit number is accepted for the addressbook
  // convenience paths). Reject obviously-malformed inputs.
  if (digits.length < 5 || digits.length > 15) return null;
  return digits;
}

function toChatId(phone: string): string {
  return `${phone}${NEUTRAL_SUFFIX}`;
}

/**
 * Local persistence + analytics for the cold-outreach workflow.
 *
 *  - `registry_contacts`: the app's OWN dedupe source for bulk import. A phone already present is
 *    never double-saved (the core "message if number already saved in contacts" requirement).
 *  - `registry_blocked`: a durable blocked/reported registry spanning restarts.
 *  - reply tracking: computed over the already-persisted `messages` table (incoming rows per chat).
 *  - per-session reply statistics for the dashboard ring-out panel.
 */
@Injectable()
export class RegistryService {
  private readonly logger = createLogger('RegistryService');

  constructor(
    @InjectRepository(RegistryContact, 'data') private readonly contacts: Repository<RegistryContact>,
    @InjectRepository(RegistryBlocked, 'data') private readonly blocked: Repository<RegistryBlocked>,
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
    private readonly contactService: ContactService,
    private readonly sessionService: SessionService,
  ) {}

  /** All sessions with a ready engine (used for WhatsApp addressbook mirror + blocklist read). */
  private async getReadySessions(): Promise<Session[]> {
    const list = await this.sessions.find().catch(() => [] as Session[]);
    return list.filter(s => s.status === 'ready');
  }

  /**
   * Bulk import with local dedupe. Never double-saves a number already in the registry. Optionally
   * also skips numbers already in the WhatsApp addressbook, and may mirror-save new numbers into
   * the WhatsApp addressbook (so the number appears saved on the phone itself).
   */
  async importContacts(dto: ImportContactsDto): Promise<ImportContactsResultDto> {
    const result: ImportContactsResultDto = {
      total: 0,
      added: 0,
      duplicatesLocal: 0,
      duplicatesWhatsApp: 0,
      invalid: 0,
      notOnWhatsApp: 0,
      addedPhones: [],
    };

    // Normalize + collapse duplicates within the submission itself.
    const seen = new Map<string, string | undefined>();
    for (const item of dto.items) {
      const phone = normalizePhone(item.phone ?? '');
      if (!phone) {
        result.invalid += 1;
        continue;
      }
      if (!seen.has(phone)) seen.set(phone, item.name?.trim() || undefined);
    }
    result.total = seen.size;

    // Optional live WHOIS: drop numbers that are not registered on WhatsApp. Uses the first ready
    // session's engine (one RPC per number) so the registry only ever holds real WhatsApp numbers.
    if (dto.verifyOnWhatsApp) {
      const ready = await this.getReadySessions();
      if (ready.length === 0) {
        this.logger.warn('verifyOnWhatsApp requested but no ready session — skipping number verification');
      } else {
        const verifierId = ready[0].id;
        for (const phone of [...seen.keys()]) {
          let exists = false;
          try {
            exists = await this.contactService.checkNumberExists(verifierId, toChatId(phone));
          } catch (e) {
            this.logger.debug(`number check failed for ${phone}`, {
              error: e instanceof Error ? e.message : String(e),
            });
          }
          if (!exists) {
            result.notOnWhatsApp += 1;
            seen.delete(phone);
          }
        }
        result.total = seen.size;
      }
    }

    // Dedupe against the existing local registry (case-insensitive phone match on the unique index).
    const existingPhones = new Set<string>();
    const existingRows = await this.contacts.find();
    for (const row of existingRows) existingPhones.add(row.phone);

    // Optional engine truth: numbers already in the WhatsApp addressbook are skipped and NOT
    // mirrored (they are already saved on the phone).
    const whatsAppPhones = new Set<string>();
    if (dto.checkWhatsAppAddressbook) {
      const readySessions = await this.getReadySessions();
      for (const s of readySessions) {
        try {
          const list = await this.contactService.getContacts(s.id, { limit: 1000 });
          for (const c of list) {
            if (c && typeof c.number === 'string') {
              const p = normalizePhone(c.number);
              if (p) whatsAppPhones.add(p);
            }
          }
        } catch (e) {
          this.logger.debug(`addressbook read failed for ${s.name}`, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    const localAdded: RegistryContact[] = [];
    for (const [phone, name] of seen) {
      if (existingPhones.has(phone) || whatsAppPhones.has(phone)) {
        if (existingPhones.has(phone)) result.duplicatesLocal += 1;
        else result.duplicatesWhatsApp += 1;
        continue;
      }
      localAdded.push(this.contacts.create({ phone, name: name ?? null, campaignId: dto.campaignId ?? null }));
    }

    if (localAdded.length > 0) {
      // Insert one-by-one to keep the per-row unique error from failing the whole batch, but a
      // concurrent insert racing us is benignly treated as a duplicate.
      for (const row of localAdded) {
        try {
          await this.contacts.save(row);
          result.added += 1;
          result.addedPhones.push(row.phone);
        } catch (e) {
          this.logger.warn(`contact save failed for ${row.phone}: ${e instanceof Error ? e.message : String(e)}`);
          result.duplicatesLocal += 1;
        }
      }
    }

    // Optional mirror into the WhatsApp addressbook of a target session.
    if (dto.saveToWhatsApp && result.addedPhones.length > 0) {
      const readySessions = await this.getReadySessions();
      const target = readySessions.find(s => s.name === dto.sessionName) ?? readySessions[0];
      if (target) {
        for (const phone of result.addedPhones) {
          const meta = await this.contacts.findOneBy({ phone });
          const firstName = meta?.name || phone;
          try {
            await this.contactService.upsertContact(target.id, toChatId(phone), firstName);
          } catch (e) {
            this.logger.debug(`addressbook mirror-save failed for ${phone}`, {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    }

    return result;
  }

  /**
   * List local registry contacts, each annotated with reply status from the persisted message
   * store (whether any session received an incoming message from that number).
   */
  async listContacts(limit = 500): Promise<RegistryContactDto[]> {
    const rows = await this.contacts.find({ order: { createdAt: 'DESC' }, take: Math.min(limit, 5000) });
    if (rows.length === 0) return [];

    // Reply tracking: one query over the incoming message rows for the whole chatId set.
    const chatIds = rows.map(r => toChatId(r.phone));
    const incoming = await this.messages.find({
      where: { direction: MessageDirection.INCOMING, chatId: In(chatIds) },
      order: { timestamp: 'ASC' },
    });

    const byChat = new Map<string, { count: number; last: number | null }>();
    for (const m of incoming) {
      const rec = byChat.get(m.chatId) ?? { count: 0, last: null };
      rec.count += 1;
      const ts = Number(m.timestamp);
      if (!Number.isNaN(ts) && (rec.last === null || ts > rec.last)) rec.last = ts;
      byChat.set(m.chatId, rec);
    }

    return rows.map(r => {
      const rec = byChat.get(toChatId(r.phone));
      return {
        id: r.id,
        phone: r.phone,
        name: r.name ?? null,
        campaignId: r.campaignId ?? null,
        sessionName: r.sessionName ?? null,
        replied: (rec?.count ?? 0) > 0,
        lastIncomingAt: rec?.last != null ? new Date(rec.last * 1000).toISOString() : null,
        incomingCount: rec?.count ?? 0,
        createdAt: r.createdAt,
      };
    });
  }

  /** Record a blocked/reported event into the durable registry (upsert: one row per phone+kind). */
  async recordBlocked(input: { phone: string; kind?: 'blocked' | 'reported'; sessionName?: string; source?: 'manual' | 'engine' }): Promise<RegistryBlockedDto> {
    const phone = normalizePhone(input.phone ?? '');
    if (!phone) throw new Error('Invalid phone number');
    const kind = input.kind === 'reported' ? BlockKind.REPORTED : BlockKind.BLOCKED;
    const existing = await this.blocked.findOneBy({ phone, kind });
    if (existing) {
      existing.sessionName = input.sessionName ?? existing.sessionName;
      existing.source = input.source ?? existing.source;
      await this.blocked.save(existing);
      return this.toBlockedDto(existing);
    }
    const row = this.blocked.create({
      phone,
      kind,
      sessionName: input.sessionName ?? null,
      source: input.source ?? 'manual',
    });
    await this.blocked.save(row);
    return this.toBlockedDto(row);
  }

  /** Remove a number from the blocked/reported registry. */
  async removeBlocked(phone: string, kind?: 'blocked' | 'reported'): Promise<{ removed: boolean }> {
    const p = normalizePhone(phone);
    if (!p) return { removed: false };
    const where = kind === 'reported' ? { phone: p, kind: BlockKind.REPORTED }
      : kind === 'blocked' ? { phone: p, kind: BlockKind.BLOCKED }
      : { phone: p };
    const res = await this.blocked.delete(where);
    return { removed: (res.affected ?? 0) > 0 };
  }

  /** Blocked + reported registry, optionally unioning the LIVE engine blocklists. */
  async listBlocked(includeEngine = true): Promise<{ items: RegistryBlockedDto[]; engineBlocked: string[] }> {
    const rows = await this.blocked.find({ order: { createdAt: 'DESC' } });
    const items = rows.map(r => this.toBlockedDto(r));

    const engineBlocked: string[] = [];
    if (includeEngine) {
      const ready = await this.getReadySessions();
      for (const s of ready) {
        try {
          const ids = await this.contactService.getBlockedContacts(s.id);
          for (const id of ids) {
            if (typeof id === 'string') {
              const p = normalizePhone(id);
              if (p && !engineBlocked.includes(p)) engineBlocked.push(p);
            }
          }
        } catch {
          /* engine blocklist query unanswered — skip */
        }
      }
    }
    return { items, engineBlocked };
  }

  /** Per-session reply analytics for the dashboard ring-out panel. */
  async sessionReplyStats(): Promise<SessionReplyStatsDto[]> {
    const sessions = await this.sessions.find({ order: { name: 'ASC' } });
    const registryPhones = await this.contacts.find();
    const chatIdToPhone = new Map(registryPhones.map(r => [toChatId(r.phone), r.phone]));

    const out: SessionReplyStatsDto[] = [];
    for (const s of sessions) {
      const sessionId = s.id;
      const sentRows = await this.messages.find({
        where: { sessionId, direction: MessageDirection.OUTGOING },
        select: { chatId: true, id: true },
      });
      const sentChatIds = new Set(sentRows.map(m => m.chatId).filter(Boolean));
      let replied = 0;
      for (const chatId of sentChatIds) {
        if (!chatIdToPhone.has(chatId)) continue; // only count registry contacts
        const inc = await this.messages.count({
          where: { sessionId, chatId, direction: MessageDirection.INCOMING },
        });
        if (inc > 0) replied += 1;
      }
      const blocked = await this.blocked.count({ where: { sessionName: s.name, kind: BlockKind.BLOCKED } });
      const reported = await this.blocked.count({ where: { sessionName: s.name, kind: BlockKind.REPORTED } });
      out.push({
        sessionName: s.name,
        sessionId,
        sent: sentChatIds.size,
        replied,
        replyRate: sentChatIds.size > 0 ? replied / sentChatIds.size : 0,
        blocked,
        reported,
      });
    }
    return out;
  }

  private toBlockedDto(row: RegistryBlocked): RegistryBlockedDto {
    return {
      id: row.id,
      phone: row.phone,
      kind: row.kind as 'blocked' | 'reported',
      sessionName: row.sessionName ?? null,
      source: row.source,
      createdAt: row.createdAt,
    };
  }
}
