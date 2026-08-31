import { Injectable, BadRequestException, NotFoundException, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { SessionRestrictionStore } from '../session/session-restriction-store.service';
import { BulkMessageService } from '../message/bulk-message.service';
import { BatchStatus } from '../message/entities/message-batch.entity';
import { OutreachCampaign, OutreachStatus } from './entities/outreach-campaign.entity';
import { CreateOutreachCampaignDto, OutreachCampaignResponseDto } from './dto/outreach-campaign.dto';
import {
  OutreachContact,
  OutreachSession as AllocationSession,
  allocateOutreach,
  warmupAllowanceForAge,
  OutreachBurst,
} from './outreach-allocation';

const DEFAULT_WARMUP_SCHEDULE = [20, 40, 80, 160, 320, 640, 1000];
const DEFAULT_BURST_SIZE = 10;
const DEFAULT_COOLDOWN_MIN_MS = 4 * 60 * 1000;
const DEFAULT_COOLDOWN_MAX_MS = 8 * 60 * 1000;
const DEFAULT_MIN_DELAY_MS = 30000;
const DEFAULT_MAX_DELAY_MS = 120000;
const TICK_MS = 2000;

interface SessionRuntime {
  sessionId: string;
  /** Ordered bursts assigned to this session (from distribution). */
  bursts: OutreachBurst[];
  /** Next burst index to dispatch (0-based). */
  nextBurstIndex: number;
  /** Whether this session currently has an in-flight batch being processed. */
  inFlight: boolean;
  /** Timestamp (ms) at which this session may dispatch its next burst. */
  nextAvailableAt: number;
  /** Short batchId currently in flight (for status polling / cancel). */
  activeBatchId?: string;
}

interface CampaignRuntime {
  campaignId: string;
  /** Per-session runtime keyed by sessionId. */
  sessions: Map<string, SessionRuntime>;
  timer: ReturnType<typeof setInterval> | null;
  stopped: boolean;
}

@Injectable()
export class OutreachService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachService.name);
  private readonly runtimes = new Map<string, CampaignRuntime>();

  constructor(
    @InjectRepository(OutreachCampaign, 'data')
    private readonly campaignRepository: Repository<OutreachCampaign>,
    private readonly sessionService: SessionService,
    private readonly bulkMessage: BulkMessageService,
    private readonly restrictionStore: SessionRestrictionStore,
  ) {}

  /** On boot, recover any campaigns that were "running" when the process last stopped. */
  async onModuleInit(): Promise<void> {
    const running = await this.campaignRepository.find({ where: { status: OutreachStatus.RUNNING } });
    for (const campaign of running) {
      this.logger.log(`resuming campaign ${campaign.name} (${campaign.id})`);
      this.startRuntime(campaign);
    }
  }

  /** Resolve the campaign's session pool with warm-up capacity per session. */
  private async resolveSessionPool(
    dtoNames: string[],
    warmupSchedule: number[],
    maxPerSessionPerDay?: number,
  ): Promise<{ sessions: Array<AllocationSession & { entity: Session }>; missing: string[] }> {
    const all = await this.sessionService.findAll();
    const byName = new Map(all.map((s) => [s.name, s]));
    const missing: string[] = [];
    const resolved: Array<AllocationSession & { entity: Session }> = [];

    for (const name of dtoNames) {
      const entity = byName.get(name);
      if (!entity) {
        missing.push(name);
        continue;
      }
      const ageDays = entity.createdAt
        ? (Date.now() - new Date(entity.createdAt).getTime()) / 86400000
        : 0;
      const warmupCap = warmupAllowanceForAge(warmupSchedule, ageDays);
      const capacity = maxPerSessionPerDay ? Math.min(warmupCap, maxPerSessionPerDay) : warmupCap;
      resolved.push({
        id: entity.id,
        name: entity.name,
        capacity,
        entity,
      });
    }
    return { sessions: resolved, missing };
  }

  private async createCampaign(dto: CreateOutreachCampaignDto): Promise<OutreachCampaign> {
    const warmupSchedule = dto.strategy?.warmupSchedule ?? DEFAULT_WARMUP_SCHEDULE;
    const names = dto.sessions.map((s) => s.sessionName);
    const { sessions, missing } = await this.resolveSessionPool(names, warmupSchedule, dto.strategy?.maxPerSessionPerDay);
    if (missing.length) {
      throw new BadRequestException(
        `Unknown session(s): ${missing.join(', ')}. Register/save them first (e.g. via the snapshot feature).`,
      );
    }

    const burstSize = dto.strategy?.burstSize ?? DEFAULT_BURST_SIZE;
    const allocation = allocateOutreach(
      dto.contacts.map((c) => ({ phone: c.phone, name: c.name })),
      sessions.map((s) => ({ id: s.id, name: s.name, capacity: s.capacity })),
      burstSize,
    );

    const distribution = allocation.sessions.map((s) => ({
      sessionId: s.id,
      sessionName: s.name,
      assigned: s.assigned,
      contacts: s.bursts.flatMap((b) => b.contacts),
      bursts: s.bursts.map((b) => ({ burstIndex: b.burstIndex, contacts: b.contacts })),
    }));

    const campaign = this.campaignRepository.create({
      name: dto.name,
      status: OutreachStatus.SCHEDULED,
      messageText: dto.messageText,
      variableMap: dto.variableMap ?? null,
      contacts: dto.contacts.map((c) => ({ phone: c.phone, name: c.name })),
      sessions: sessions.map((s) => ({ sessionName: s.name, sessionId: s.id })),
      strategy: {
        burstSize,
        cooldownMinMs: dto.strategy?.cooldownMinMs ?? DEFAULT_COOLDOWN_MIN_MS,
        cooldownMaxMs: Math.max(
          dto.strategy?.cooldownMaxMs ?? DEFAULT_COOLDOWN_MAX_MS,
          dto.strategy?.cooldownMinMs ?? DEFAULT_COOLDOWN_MIN_MS,
        ),
        warmupSchedule,
        pacing: {
          minDelayMs: dto.strategy?.pacing?.minDelayMs ?? DEFAULT_MIN_DELAY_MS,
          maxDelayMs: dto.strategy?.pacing?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
        },
        preCheckNumbers: dto.strategy?.preCheckNumbers ?? true,
        saveContactFirst: dto.strategy?.saveContactFirst ?? true,
        contactName: dto.strategy?.contactName,
        maxPerSessionPerDay: dto.strategy?.maxPerSessionPerDay,
      },
      distribution,
      sessionProgress: distribution.map((d) => ({
        sessionId: d.sessionId,
        sessionName: d.sessionName,
        total: d.assigned,
        sent: 0,
        failed: 0,
        pending: d.assigned,
      })),
      error: null,
      startedAt: null,
      completedAt: null,
    });

    const saved = await this.campaignRepository.save(campaign);
    this.logger.log(
      `outreach campaign '${saved.name}' (${saved.id}) allocated ${allocation.totalAssigned} of ${dto.contacts.length} contacts ` +
        `across ${sessions.length} sessions (${allocation.unassigned.length} unassigned; warm-up-capped).`,
    );
    return saved;
  }

  /** Random cooldown in [min, max]; falls back to min when the range is degenerate. */
  private drawCooldown(minMs: number, maxMs: number): number {
    const lo = Math.max(0, minMs ?? 0);
    const hi = Math.max(lo, maxMs ?? lo);
    if (hi <= lo) return lo;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  private applyVariables(text: string, variableMap: Record<string, string> | null): string {
    if (!variableMap) return text;
    let out = text;
    for (const [k, v] of Object.entries(variableMap)) {
      out = out.split(`{{${k}}}`).join(v);
    }
    return out;
  }

  private async dispatchBurst(
    campaign: OutreachCampaign,
    runtime: SessionRuntime,
  ): Promise<void> {
    const burst = runtime.bursts[runtime.nextBurstIndex];
    if (!burst) return;
    runtime.inFlight = true;
    const cooldownMs = this.drawCooldown(campaign.strategy.cooldownMinMs, campaign.strategy.cooldownMaxMs);
    const avgDelay = (campaign.strategy.pacing.maxDelayMs + campaign.strategy.pacing.minDelayMs) / 2;
    const burstMs = burst.contacts.length * avgDelay;

    const batchId = `oc-${campaign.id.slice(0, 8)}-${burst.sessionId.replace(/-/g, '').slice(0, 6)}-${runtime.nextBurstIndex}`;
    runtime.activeBatchId = batchId;

    const body = this.applyVariables(campaign.messageText, campaign.variableMap);

    try {
      await this.bulkMessage.createBatch(burst.sessionId, {
        batchId,
        messages: burst.contacts.map((c) => ({
          chatId: `${normalizePhone(c.phone)}@c.us`,
          type: 'text',
          content: { text: this.applyVariables(campaign.messageText, { ...campaign.variableMap, name: c.name || c.phone, phone: c.phone }) },
          variables: { name: c.name || c.phone, phone: c.phone },
        })),
        options: {
          minDelayMs: campaign.strategy.pacing.minDelayMs,
          maxDelayMs: campaign.strategy.pacing.maxDelayMs,
          enableTyping: true,
          randomizeDelay: true,
          saveContactFirst: campaign.strategy.saveContactFirst,
          preCheckNumbers: campaign.strategy.preCheckNumbers,
          contactName: campaign.strategy.contactName,
        },
      });
      // Track the batch ID on the campaign so the frontend can query per-recipient results.
      const fresh = await this.campaignRepository.findOne({ where: { id: campaign.id } });
      if (fresh) {
        fresh.batchIds = [...(fresh.batchIds ?? []), batchId];
        await this.campaignRepository.save(fresh);
      }
      runtime.nextBurstIndex += 1;
      // Session is now busy for the burst duration then cooling down.
      runtime.nextAvailableAt = Date.now() + burstMs + cooldownMs;
    } catch (err) {
      runtime.inFlight = false;
      runtime.activeBatchId = undefined;
      // Transient errors (session not active, engine not loaded) retry quickly; persistent errors
      // (invalid payload, auth failure) wait the full cooldown to avoid hot-looping.
      const msg = (err as Error).message ?? '';
      const isTransient = /not active|not started|ECONNREFUSED|ECONNRESET|timeout/i.test(msg);
      const retryMs = isTransient ? 10_000 : cooldownMs;
      runtime.nextAvailableAt = Date.now() + retryMs;
      this.logger.warn(`campaign ${campaign.id} session ${runtime.sessionId} burst dispatch failed${isTransient ? ' (transient, retry in 10s)' : ''}: ${msg}`);
    }
  }

  private async pollCampaign(campaign: OutreachCampaign, runtime: CampaignRuntime): Promise<void> {
    // Advance each session: complete in-flight batches, then dispatch the next burst when its
    // cool-down has elapsed.
    for (const [sessionId, sr] of runtime.sessions) {
      if (sr.inFlight && sr.activeBatchId) {
        let status: BatchStatus;
        try {
          const batch = await this.bulkMessage.getBatchStatus(sessionId, sr.activeBatchId);
          status = batch.status;
          if (status === BatchStatus.COMPLETED || status === BatchStatus.CANCELLED || status === BatchStatus.FAILED) {
            const sent = batch.progress?.sent ?? 0;
            const failed = batch.progress?.failed ?? 0;
            await this.updateSessionTally(campaign.id, sessionId, sent, failed);
            sr.inFlight = false;
            sr.activeBatchId = undefined;
            // After a terminal batch, cool-down governs the next dispatch (already folded into
            // nextAvailableAt at dispatch time).
          }
        } catch {
          // Batch not visible yet (createBatch persists before returning, so a missing row is rare);
          // leave in-flight and retry next tick.
        }
      }

      // Dispatch next burst if: session not in flight, has a next burst, cool-down elapsed.
      if (
        !runtime.stopped &&
        !sr.inFlight &&
        sr.nextBurstIndex < sr.bursts.length &&
        Date.now() >= sr.nextAvailableAt
      ) {
        await this.dispatchBurst(campaign, sr);
      }
    }
  }

  private async updateSessionTally(
    campaignId: string,
    sessionId: string,
    sent: number,
    failed: number,
  ): Promise<void> {
    const campaign = await this.campaignRepository.findOne({ where: { id: campaignId } });
    if (!campaign) return;
    const progress = campaign.sessionProgress ?? [];
    const row = progress.find((p) => p.sessionId === sessionId);
    if (row) {
      row.sent = sent;
      row.failed = failed;
      row.pending = Math.max(0, row.total - sent - failed);
    }
    const sentTotal = progress.reduce((a, p) => a + (p.sent ?? 0), 0);
    const pendingTotal = progress.reduce((a, p) => a + (p.pending ?? 0), 0);

    if (pendingTotal <= 0 && sentTotal > 0) {
      campaign.status = OutreachStatus.COMPLETED;
      campaign.completedAt = new Date();
      this.stopRuntime(campaignId);
    }
    await this.campaignRepository.save(campaign);
  }

  private startRuntime(campaign: OutreachCampaign): void {
    if (this.runtimes.has(campaign.id)) return;
    const runtime: CampaignRuntime = {
      campaignId: campaign.id,
      sessions: new Map(),
      timer: null,
      stopped: false,
    };
    for (const sd of campaign.distribution ?? []) {
      runtime.sessions.set(sd.sessionId, {
        sessionId: sd.sessionId,
        bursts: sd.bursts.map((b) => ({
          burstIndex: b.burstIndex,
          sessionId: sd.sessionId,
          sessionName: sd.sessionName,
          contacts: b.contacts,
        })),
        nextBurstIndex: 0,
        inFlight: false,
        nextAvailableAt: 0,
      });
    }
    this.runtimes.set(campaign.id, runtime);

    const tick = async () => {
      const fresh = await this.campaignRepository.findOne({ where: { id: campaign.id } });
      if (!fresh || runtime.stopped) return;
      await this.pollCampaign(fresh, runtime);
    };
    runtime.timer = setInterval(() => void tick(), TICK_MS);
  }

  private stopRuntime(campaignId: string): void {
    const runtime = this.runtimes.get(campaignId);
    if (!runtime) return;
    runtime.stopped = true;
    if (runtime.timer) clearInterval(runtime.timer);
    this.runtimes.delete(campaignId);
  }

  async create(dto: CreateOutreachCampaignDto): Promise<OutreachCampaignResponseDto> {
    const campaign = await this.createCampaign(dto);
    return this.toResponse(campaign);
  }

  async start(id: string): Promise<OutreachCampaignResponseDto> {
    const campaign = await this.campaignRepository.findOne({ where: { id } });
    if (!campaign) throw new NotFoundException(`Campaign '${id}' not found`);
    if (campaign.status === OutreachStatus.RUNNING) return this.toResponse(campaign);

    // Restart a finished or stopped campaign from scratch: reset tallies, batch history and timestamps
    // so the runtime re-runs the full distribution plan.
    campaign.status = OutreachStatus.RUNNING;
    campaign.startedAt = new Date();
    campaign.completedAt = null;
    campaign.error = null;
    campaign.batchIds = [];
    if (campaign.distribution) {
      campaign.sessionProgress = campaign.distribution.map(d => ({
        sessionId: d.sessionId,
        sessionName: d.sessionName,
        total: d.assigned,
        sent: 0,
        failed: 0,
        pending: d.assigned,
      }));
    }
    await this.campaignRepository.save(campaign);

    this.startRuntime(campaign);
    return this.toResponse(campaign);
  }

  async stop(id: string): Promise<OutreachCampaignResponseDto> {
    const campaign = await this.campaignRepository.findOne({ where: { id } });
    if (!campaign) throw new NotFoundException(`Campaign '${id}' not found`);
    if (campaign.status === OutreachStatus.COMPLETED || campaign.status === OutreachStatus.CANCELLED) {
      return this.toResponse(campaign);
    }

    // Cancel any in-flight batches so sessions stop sending immediately.
    const runtime = this.runtimes.get(id);
    for (const sr of runtime?.sessions.values() ?? []) {
      if (sr.inFlight && sr.activeBatchId) {
        try {
          await this.bulkMessage.cancelBatch(sr.sessionId, sr.activeBatchId);
        } catch {
          // batch already terminal
        }
      }
    }

    campaign.status = OutreachStatus.CANCELLED;
    campaign.completedAt = new Date();
    await this.campaignRepository.save(campaign);
    this.stopRuntime(id);
    return this.toResponse(campaign);
  }

  async status(id: string): Promise<OutreachCampaignResponseDto> {
    const campaign = await this.campaignRepository.findOne({ where: { id } });
    if (!campaign) throw new NotFoundException(`Campaign '${id}' not found`);
    return this.toResponse(campaign);
  }

  async list(): Promise<OutreachCampaignResponseDto[]> {
    const campaigns = await this.campaignRepository.find({ order: { createdAt: 'DESC' } });
    return campaigns.map((c) => this.toResponse(c));
  }

  /**
   * Execution report: query every batch created during the campaign and return per-recipient
   * results (sent/failed/pending/messageId/error) grouped by session.
   */
  async executionReport(id: string) {
    const campaign = await this.campaignRepository.findOne({ where: { id } });
    if (!campaign) throw new NotFoundException(`Campaign '${id}' not found`);

    const batchIds = campaign.batchIds ?? [];
    const sessionMap = new Map(campaign.sessions.map((s) => [s.sessionId, s.sessionName]));
    const results: Array<{
      sessionId: string;
      sessionName: string;
      batchId: string;
      status: string;
      progress: { total: number; sent: number; failed: number; pending: number; cancelled: number };
      recipients: Array<{ chatId: string; status: string; messageId?: string; error?: string; sentAt?: string }>;
    }> = [];

    for (const batchId of batchIds) {
      // Find which session this batch belongs to by parsing the batchId prefix.
      const sessionId = [...sessionMap.keys()].find((sid) => batchId.includes(sid.replace(/-/g, '').slice(0, 6)));
      if (!sessionId) continue;
      try {
        const batch = await this.bulkMessage.getBatchStatus(sessionId, batchId);
        results.push({
          sessionId,
          sessionName: sessionMap.get(sessionId) ?? sessionId,
          batchId,
          status: batch.status,
          progress: batch.progress,
          recipients: (batch.results ?? []).map((r) => ({
            chatId: r.chatId,
            status: String(r.status),
            messageId: r.messageId,
            error: r.error?.message,
            sentAt: r.sentAt?.toISOString?.() ?? undefined,
          })),
        });
      } catch {
        // Batch not found or expired — still include it with empty recipients.
        results.push({
          sessionId,
          sessionName: sessionMap.get(sessionId) ?? sessionId,
          batchId,
          status: 'unknown',
          progress: { total: 0, sent: 0, failed: 0, pending: 0, cancelled: 0 },
          recipients: [],
        });
      }
    }

    // Live runtime state per session: which burst is next/in-flight, and the countdown until the
    // session can dispatch again (cooldown/elongated by the burst currently being paced out).
    const runtime = this.runtimes.get(id);
    const liveSessions: Array<{
      sessionName: string;
      sessionId: string;
      totalBursts: number;
      nextBurstIndex: number;
      inFlight: boolean;
      activeBatchId: string | null;
      nextAvailableAt: number;
      now: number;
      dispatchedBurstCount: number;
    }> = [];
    if (runtime) {
      for (const [sid, sr] of runtime.sessions) {
        liveSessions.push({
          sessionName: sessionMap.get(sid) ?? sid,
          sessionId: sid,
          totalBursts: sr.bursts.length,
          nextBurstIndex: sr.nextBurstIndex,
          inFlight: sr.inFlight,
          activeBatchId: sr.activeBatchId ?? null,
          nextAvailableAt: sr.nextAvailableAt,
          now: Date.now(),
          dispatchedBurstCount: sr.nextBurstIndex,
        });
      }
    }

    return {
      campaignId: id,
      campaignName: campaign.name,
      status: campaign.status,
      sessionProgress: campaign.sessionProgress,
      batches: results,
      live: runtime ? { sessions: liveSessions } : null,
    };
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    const campaign = await this.campaignRepository.findOne({ where: { id } });
    if (!campaign) throw new NotFoundException(`Campaign '${id}' not found`);
    if (campaign.status === OutreachStatus.RUNNING) {
      throw new BadRequestException(`Campaign '${id}' is running. Stop it before deleting.`);
    }
    this.stopRuntime(id);
    await this.campaignRepository.delete({ id });
    return { deleted: true };
  }

  private toResponse(campaign: OutreachCampaign): OutreachCampaignResponseDto {
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      messageText: campaign.messageText,
      contactCount: campaign.contacts.length,
      sessionCount: campaign.sessions.length,
      sessionProgress: campaign.sessionProgress,
      batchIds: campaign.batchIds,
      distribution: campaign.distribution,
      strategy: campaign.strategy,
      sessions: campaign.sessions,
      error: campaign.error,
      startedAt: campaign.startedAt,
      completedAt: campaign.completedAt,
    };
  }

  onModuleDestroy(): void {
    for (const id of [...this.runtimes.keys()]) this.stopRuntime(id);
  }
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}
