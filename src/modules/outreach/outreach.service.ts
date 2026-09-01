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
  bursts: OutreachBurst[];
  nextBurstIndex: number;
  inFlight: boolean;
  nextAvailableAt: number;
  activeBatchId?: string;
}

interface CampaignRuntime {
  campaignId: string;
  sessions: Map<string, SessionRuntime>;
  timer: ReturnType<typeof setInterval> | null;
  stopped: boolean;
}

function isBlockedError(code?: string, message?: string): boolean {
  const c = (code || '').toUpperCase();
  const m = (message || '').toLowerCase();
  if (['SEND_BLOCKED', 'SEND_PACING_LIMITED', 'RATE_LIMIT', 'BLOCKED', 'BAN'].includes(c)) return true;
  return /rate[- ]?limit|blocked|ban|timelock|reachout|tos_block|spam|restricted/.test(m);
}

function avgDelayMs(strategy: OutreachCampaign['strategy']): number {
  return (strategy.pacing.maxDelayMs + strategy.pacing.minDelayMs) / 2;
}

function avgCooldownMs(strategy: OutreachCampaign['strategy']): number {
  return (strategy.cooldownMinMs + strategy.cooldownMaxMs) / 2;
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

  async onModuleInit(): Promise<void> {
    const running = await this.campaignRepository.find({ where: { status: OutreachStatus.RUNNING } });
    for (const campaign of running) {
      this.logger.log(`resuming campaign ${campaign.name} (${campaign.id})`);
      this.startRuntime(campaign);
    }
  }

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

  private buildBurstProgress(
    distribution: OutreachCampaign['distribution'],
    strategy: OutreachCampaign['strategy'],
    startedAt?: Date | null,
  ): OutreachCampaign['burstProgress'] {
    if (!distribution) return [];
    const avgDelay = avgDelayMs(strategy);
    const avgCooldown = avgCooldownMs(strategy);
    const base = startedAt ? startedAt.getTime() : Date.now();
    const perSessionCursor = new Map<string, number>();
    const out: NonNullable<OutreachCampaign['burstProgress']> = [];
    // Interleave estimation: round-robin wave timing — burst 0 of all sessions first, then burst 1, etc.
    // For simple per-session sequential ETA we estimate linearly per session.
    for (const sd of distribution) {
      let cursor = base;
      for (let i = 0; i < sd.bursts.length; i++) {
        const b = sd.bursts[i];
        const burstMs = b.contacts.length * avgDelay;
        const warmupMs = i === 0 ? 0 : avgCooldown;
        if (i > 0) cursor += avgCooldown;
        const estStart = new Date(cursor).toISOString();
        const estEnd = new Date(cursor + burstMs).toISOString();
        out.push({
          sessionId: sd.sessionId,
          sessionName: sd.sessionName,
          burstIndex: b.burstIndex,
          burstSize: b.contacts.length,
          batchId: null,
          status: 'pending',
          sent: 0,
          failed: 0,
          blocked: 0,
          pending: b.contacts.length,
          contacts: b.contacts,
          results: [],
          startTime: null,
          endTime: null,
          estimatedStart: estStart,
          estimatedEnd: estEnd,
          cooldownMs: i < sd.bursts.length - 1 ? avgCooldown : null,
          warmupMs,
        });
        cursor += burstMs;
      }
    }
    return out;
  }

  private recomputeEstimates(campaign: OutreachCampaign): void {
    if (!campaign.burstProgress || !campaign.startedAt) return;
    const avgDelay = avgDelayMs(campaign.strategy);
    const avgCooldown = avgCooldownMs(campaign.strategy);
    // Group by session
    const bySession = new Map<string, typeof campaign.burstProgress>();
    for (const bp of campaign.burstProgress) {
      const arr = bySession.get(bp.sessionId) ?? [];
      arr.push(bp);
      bySession.set(bp.sessionId, arr);
    }
    for (const [, list] of bySession) {
      list.sort((a, b) => a.burstIndex - b.burstIndex);
      let cursor = new Date(campaign.startedAt).getTime();
      for (let i = 0; i < list.length; i++) {
        const bp = list[i];
        if (bp.status === 'completed' || bp.status === 'failed') {
          const end = bp.endTime ? new Date(bp.endTime).getTime() : cursor + bp.burstSize * avgDelay;
          cursor = end + (bp.cooldownMs ?? avgCooldown);
          continue;
        }
        if (bp.status === 'running') {
          const start = bp.startTime ? new Date(bp.startTime).getTime() : cursor;
          bp.estimatedStart = new Date(start).toISOString();
          bp.estimatedEnd = new Date(start + bp.burstSize * avgDelay).toISOString();
          cursor = start + bp.burstSize * avgDelay + (bp.cooldownMs ?? avgCooldown);
          continue;
        }
        // pending or cooldown
        if (i > 0) {
          const prev = list[i - 1];
          const prevEnd = prev.endTime ? new Date(prev.endTime).getTime() : new Date(prev.estimatedEnd!).getTime();
          cursor = prevEnd + (prev.cooldownMs ?? avgCooldown);
        }
        bp.estimatedStart = new Date(cursor).toISOString();
        bp.estimatedEnd = new Date(cursor + bp.burstSize * avgDelay).toISOString();
        cursor += bp.burstSize * avgDelay + (bp.cooldownMs ?? avgCooldown);
      }
    }
  }

  private computeGlobalTiming(campaign: OutreachCampaign): { startedAt: string | null; estimatedFinish: string | null; remainingBursts: number; totalBursts: number; completedBursts: number } {
    const totalBursts = campaign.burstProgress?.length ?? campaign.distribution?.reduce((a, s) => a + s.bursts.length, 0) ?? 0;
    const completedBursts = campaign.burstProgress?.filter(b => b.status === 'completed').length ?? 0;
    const remainingBursts = totalBursts - completedBursts;
    if (!campaign.startedAt) return { startedAt: null, estimatedFinish: null, remainingBursts, totalBursts, completedBursts };
    if (campaign.status === 'completed' && campaign.completedAt) {
      return { startedAt: campaign.startedAt.toISOString(), estimatedFinish: campaign.completedAt.toISOString(), remainingBursts, totalBursts, completedBursts };
    }
    if (!campaign.burstProgress || campaign.burstProgress.length === 0) return { startedAt: campaign.startedAt.toISOString(), estimatedFinish: null, remainingBursts, totalBursts, completedBursts };
    // Latest estimatedEnd among pending/running is global ETA (sessions run in parallel, so max)
    const pending = campaign.burstProgress.filter(b => b.status !== 'completed' && b.estimatedEnd);
    if (pending.length === 0) {
      const last = [...campaign.burstProgress].sort((a, b) => new Date(b.estimatedEnd!).getTime() - new Date(a.estimatedEnd!).getTime())[0];
      return { startedAt: campaign.startedAt.toISOString(), estimatedFinish: last.estimatedEnd, remainingBursts, totalBursts, completedBursts };
    }
    const maxMs = Math.max(...pending.map(b => new Date(b.estimatedEnd!).getTime()), ...campaign.burstProgress.filter(b => b.endTime).map(b => new Date(b.endTime!).getTime()));
    return { startedAt: campaign.startedAt.toISOString(), estimatedFinish: new Date(maxMs).toISOString(), remainingBursts, totalBursts, completedBursts };
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

    const strategy = {
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
    };

    const burstProgress = this.buildBurstProgress(distribution as any, strategy as any, null);

    const campaign = this.campaignRepository.create({
      name: dto.name,
      status: OutreachStatus.SCHEDULED,
      messageText: dto.messageText,
      variableMap: dto.variableMap ?? null,
      contacts: dto.contacts.map((c) => ({ phone: c.phone, name: c.name })),
      sessions: sessions.map((s) => ({ sessionName: s.name, sessionId: s.id })),
      strategy,
      distribution,
      sessionProgress: distribution.map((d) => ({
        sessionId: d.sessionId,
        sessionName: d.sessionName,
        total: d.assigned,
        sent: 0,
        failed: 0,
        blocked: 0,
        pending: d.assigned,
      })),
      burstProgress,
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
    const avgDelay = avgDelayMs(campaign.strategy);
    const burstMs = burst.contacts.length * avgDelay;

    const batchId = `oc-${campaign.id.slice(0, 8)}-${burst.sessionId.replace(/-/g, '').slice(0, 6)}-${runtime.nextBurstIndex}`;
    runtime.activeBatchId = batchId;

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
      const fresh = await this.campaignRepository.findOne({ where: { id: campaign.id } });
      if (fresh) {
        fresh.batchIds = [...(fresh.batchIds ?? []), batchId];
        // Mark burst as running
        const bp = fresh.burstProgress?.find(b => b.sessionId === burst.sessionId && b.burstIndex === runtime.nextBurstIndex);
        if (bp) {
          bp.batchId = batchId;
          bp.status = 'running';
          bp.startTime = new Date().toISOString();
          bp.cooldownMs = cooldownMs;
          bp.pending = bp.burstSize;
          this.recomputeEstimates(fresh);
        }
        await this.campaignRepository.save(fresh);
      }
      runtime.nextBurstIndex += 1;
      runtime.nextAvailableAt = Date.now() + burstMs + cooldownMs;
    } catch (err) {
      runtime.inFlight = false;
      runtime.activeBatchId = undefined;
      const msg = (err as Error).message ?? '';
      const isTransient = /not active|not started|ECONNREFUSED|ECONNRESET|timeout/i.test(msg);
      const retryMs = isTransient ? 10_000 : cooldownMs;
      runtime.nextAvailableAt = Date.now() + retryMs;
      this.logger.warn(`campaign ${campaign.id} session ${runtime.sessionId} burst dispatch failed${isTransient ? ' (transient, retry in 10s)' : ''}: ${msg}`);
      // Mark burst as failed pending retry
      const fresh = await this.campaignRepository.findOne({ where: { id: campaign.id } });
      if (fresh?.burstProgress) {
        const bp = fresh.burstProgress.find(b => b.sessionId === burst.sessionId && b.burstIndex === runtime.nextBurstIndex);
        if (bp && bp.status === 'pending') {
          // keep pending for retry
        }
        await this.campaignRepository.save(fresh);
      }
    }
  }

  private async pollCampaign(campaign: OutreachCampaign, runtime: CampaignRuntime): Promise<void> {
    for (const [sessionId, sr] of runtime.sessions) {
      if (sr.inFlight && sr.activeBatchId) {
        let status: BatchStatus;
        try {
          const batch = await this.bulkMessage.getBatchStatus(sessionId, sr.activeBatchId);
          status = batch.status;
          if (status === BatchStatus.COMPLETED || status === BatchStatus.CANCELLED || status === BatchStatus.FAILED) {
            const sent = batch.progress?.sent ?? 0;
            const failed = batch.progress?.failed ?? 0;
            // Classify blocked from results
            let blocked = 0;
            const results = (batch.results ?? []).map(r => {
              const blockedFlag = isBlockedError(r.error?.code, r.error?.message);
              if (blockedFlag && r.status === 'failed') blocked++;
              return {
                chatId: r.chatId,
                status: String(r.status),
                phone: r.chatId.replace(/@.*/, ''),
                errorCode: r.error?.code,
                errorMessage: r.error?.message,
                blocked: blockedFlag,
                sentAt: r.sentAt?.toISOString?.() ?? undefined,
              };
            });
            // Infer burst index from batchId
            const burstIdxMatch = /-(\d+)$/.exec(sr.activeBatchId!);
            const burstIndex = burstIdxMatch ? Number(burstIdxMatch[1]) : sr.nextBurstIndex - 1;
            await this.updateSessionTally(campaign.id, sessionId, sent, failed, blocked);
            await this.updateBurstProgressOnComplete(campaign.id, sessionId, burstIndex, sent, failed, blocked, results, status);
            sr.inFlight = false;
            sr.activeBatchId = undefined;
          }
        } catch {
          // ignore
        }
      }

      if (
        !runtime.stopped &&
        !sr.inFlight &&
        sr.nextBurstIndex < sr.bursts.length &&
        Date.now() >= sr.nextAvailableAt
      ) {
        // Need fresh campaign for strategy/cooldown
        const fresh = await this.campaignRepository.findOne({ where: { id: campaign.id } });
        if (fresh) await this.dispatchBurst(fresh, sr);
      }
    }
  }

  private async updateBurstProgressOnComplete(
    campaignId: string,
    sessionId: string,
    burstIndex: number,
    sent: number,
    failed: number,
    blocked: number,
    results: Array<{ chatId: string; status: string; phone: string; errorCode?: string; errorMessage?: string; sentAt?: string }>,
    batchStatus: string,
  ): Promise<void> {
    const campaign = await this.campaignRepository.findOne({ where: { id: campaignId } });
    if (!campaign || !campaign.burstProgress) return;
    const bp = campaign.burstProgress.find(b => b.sessionId === sessionId && b.burstIndex === burstIndex);
    if (!bp) return;
    const failedExBlocked = Math.max(0, failed - blocked);
    bp.sent = sent;
    bp.failed = failedExBlocked;
    bp.blocked = blocked;
    bp.pending = Math.max(0, bp.burstSize - sent - failed);
    bp.status = batchStatus === 'failed' ? 'failed' : 'completed';
    bp.endTime = new Date().toISOString();
    // Map results to burst contacts with name resolution
    const contactsByPhone = new Map(bp.contacts.map(c => [c.phone, c.name]));
    bp.results = results.map(r => ({
      phone: r.phone,
      name: contactsByPhone.get(r.phone) || undefined,
      chatId: r.chatId,
      status: r.status,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      sentAt: r.sentAt,
    }));
    // If next burst exists, set it to cooldown
    const next = campaign.burstProgress.find(b => b.sessionId === sessionId && b.burstIndex === burstIndex + 1);
    if (next && next.status === 'pending') {
      next.status = 'pending'; // remain pending but estimate already computed
    }
    this.recomputeEstimates(campaign);
    await this.campaignRepository.save(campaign);
  }

  private async updateSessionTally(
    campaignId: string,
    sessionId: string,
    sent: number,
    failed: number,
    blocked: number = 0,
  ): Promise<void> {
    const campaign = await this.campaignRepository.findOne({ where: { id: campaignId } });
    if (!campaign) return;
    const progress = campaign.sessionProgress ?? [];
    const row = progress.find((p) => p.sessionId === sessionId);
    if (row) {
      row.sent = sent;
      row.failed = failed;
      (row as any).blocked = blocked;
      row.pending = Math.max(0, row.total - sent - failed);
    }
    // Aggregate per-session via burstProgress for more accurate blocked counts if available
    if (campaign.burstProgress) {
      for (const p of progress) {
        const bursts = campaign.burstProgress.filter(b => b.sessionId === p.sessionId);
        p.sent = bursts.reduce((a, b) => a + b.sent, 0);
        const failedSum = bursts.reduce((a, b) => a + b.failed, 0);
        const blockedSum = bursts.reduce((a, b) => a + b.blocked, 0);
        p.failed = failedSum;
        (p as any).blocked = blockedSum;
        p.pending = Math.max(0, p.total - p.sent - p.failed - blockedSum);
      }
    }
    const pendingTotal = progress.reduce((a, p) => a + (p.pending ?? 0), 0);
    const sentTotal = progress.reduce((a, p) => a + (p.sent ?? 0), 0);

    if (pendingTotal <= 0 && sentTotal > 0) {
      campaign.status = OutreachStatus.COMPLETED;
      campaign.completedAt = new Date();
      this.stopRuntime(campaignId);
      // Mark any remaining pending bursts as completed if no pending
      if (campaign.burstProgress) {
        for (const bp of campaign.burstProgress) {
          if (bp.status === 'pending' || bp.status === 'running') {
            bp.status = 'completed';
            if (!bp.endTime) bp.endTime = new Date().toISOString();
          }
        }
      }
    }
    this.recomputeEstimates(campaign);
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
      // Re-hydrate nextBurstIndex from burstProgress (resume)
      let nextIdx = 0;
      if (campaign.burstProgress) {
        const completed = campaign.burstProgress.filter(b => b.sessionId === sd.sessionId && (b.status === 'completed' || b.status === 'failed')).length;
        nextIdx = completed;
        // If a burst is running, mark runtime as inFlight
        const running = campaign.burstProgress.find(b => b.sessionId === sd.sessionId && b.status === 'running');
        if (running) {
          runtime.sessions.set(sd.sessionId, {
            sessionId: sd.sessionId,
            bursts: sd.bursts.map((b) => ({
              burstIndex: b.burstIndex,
              sessionId: sd.sessionId,
              sessionName: sd.sessionName,
              contacts: b.contacts,
            })),
            nextBurstIndex: nextIdx,
            inFlight: true,
            nextAvailableAt: Date.now() + 5000,
            activeBatchId: running.batchId ?? undefined,
          });
          continue;
        }
      }
      runtime.sessions.set(sd.sessionId, {
        sessionId: sd.sessionId,
        bursts: sd.bursts.map((b) => ({
          burstIndex: b.burstIndex,
          sessionId: sd.sessionId,
          sessionName: sd.sessionName,
          contacts: b.contacts,
        })),
        nextBurstIndex: nextIdx,
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
        blocked: 0,
        pending: d.assigned,
      }));
      // Rebuild burstProgress with fresh timings anchored at new start
      campaign.burstProgress = this.buildBurstProgress(campaign.distribution as any, campaign.strategy as any, campaign.startedAt);
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

    const runtime = this.runtimes.get(id);
    for (const sr of runtime?.sessions.values() ?? []) {
      if (sr.inFlight && sr.activeBatchId) {
        try {
          await this.bulkMessage.cancelBatch(sr.sessionId, sr.activeBatchId);
        } catch {
          // ignore
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
    this.recomputeEstimates(campaign);
    return this.toResponse(campaign);
  }

  async list(): Promise<OutreachCampaignResponseDto[]> {
    const campaigns = await this.campaignRepository.find({ order: { createdAt: 'DESC' } });
    for (const c of campaigns) this.recomputeEstimates(c);
    return campaigns.map((c) => this.toResponse(c));
  }

  async executionReport(id: string) {
    const campaign = await this.campaignRepository.findOne({ where: { id } });
    if (!campaign) throw new NotFoundException(`Campaign '${id}' not found`);

    this.recomputeEstimates(campaign);

    const batchIds = campaign.batchIds ?? [];
    const sessionMap = new Map(campaign.sessions.map((s) => [s.sessionId, s.sessionName]));
    const results: Array<{
      sessionId: string;
      sessionName: string;
      batchId: string;
      status: string;
      progress: { total: number; sent: number; failed: number; pending: number; cancelled: number };
      recipients: Array<{ chatId: string; phone: string; status: string; messageId?: string; error?: string; errorCode?: string; sentAt?: string; blocked?: boolean }>;
    }> = [];

    for (const batchId of batchIds) {
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
          recipients: (batch.results ?? []).map((r) => {
            const blocked = isBlockedError(r.error?.code, r.error?.message);
            return {
              chatId: r.chatId,
              phone: r.chatId.replace(/@.*/, ''),
              status: String(r.status),
              messageId: r.messageId,
              error: r.error?.message,
              errorCode: r.error?.code,
              sentAt: r.sentAt?.toISOString?.() ?? undefined,
              blocked,
            };
          }),
        });
      } catch {
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

    // Build per-session burst report from burstProgress
    const burstReport = (campaign.burstProgress ?? []).map(bp => ({
      sessionId: bp.sessionId,
      sessionName: bp.sessionName,
      burstIndex: bp.burstIndex,
      burstSize: bp.burstSize,
      batchId: bp.batchId,
      status: bp.status,
      sent: bp.sent,
      failed: bp.failed,
      blocked: bp.blocked,
      pending: bp.pending,
      contacts: bp.contacts,
      results: bp.results,
      startTime: bp.startTime,
      endTime: bp.endTime,
      estimatedStart: bp.estimatedStart,
      estimatedEnd: bp.estimatedEnd,
      cooldownMs: bp.cooldownMs,
      warmupMs: bp.warmupMs,
      progressPct: bp.burstSize > 0 ? Math.round(((bp.sent + bp.failed + bp.blocked) / bp.burstSize) * 100) : 0,
    }));

    const globalTiming = this.computeGlobalTiming(campaign);

    // Per-session summary scores (reply-rate if available via burstProgress? we use sent rate)
    const sessionScores = (campaign.sessionProgress ?? []).map(p => {
      const bursts = (campaign.burstProgress ?? []).filter(b => b.sessionId === p.sessionId);
      const totalSent = bursts.reduce((a, b) => a + b.sent, 0) || p.sent;
      const totalBlocked = bursts.reduce((a, b) => a + b.blocked, 0) || (p as any).blocked || 0;
      const score = p.total > 0 ? Math.round((totalSent / p.total) * 100) : 0;
      return {
        sessionId: p.sessionId,
        sessionName: p.sessionName,
        total: p.total,
        sent: totalSent,
        failed: p.failed,
        blocked: totalBlocked,
        pending: p.pending,
        score,
        bursts: bursts.length,
      };
    }).sort((a, b) => b.score - a.score);

    return {
      campaignId: id,
      campaignName: campaign.name,
      status: campaign.status,
      sessionProgress: campaign.sessionProgress,
      burstProgress: campaign.burstProgress,
      burstReport,
      globalTiming,
      sessionScores,
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
    this.recomputeEstimates(campaign);
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      messageText: campaign.messageText,
      contactCount: campaign.contacts.length,
      sessionCount: campaign.sessions.length,
      sessionProgress: campaign.sessionProgress as any,
      burstProgress: campaign.burstProgress as any,
      globalTiming: this.computeGlobalTiming(campaign) as any,
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
