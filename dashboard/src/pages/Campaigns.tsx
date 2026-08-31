import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Clock,
  Loader2,
  Pause,
  Play,
  Plus,
  Trash2,
  Workflow,
} from 'lucide-react';
import {
  type OutreachCampaign,
  type OutreachCampaignExecution,
  type OutreachLiveSession,
  type OutreachSessionAllocation,
} from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import {
  useCreateOutreachMutation,
  useOutreachActionMutation,
  useOutreachDeleteMutation,
  useOutreachExecutionQuery,
  useOutreachQuery,
  useRegistryContactsQuery,
  useRegistryRepliesQuery,
  useSessionsQuery,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './Campaigns.css';

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'campaigns.statusScheduled',
  running: 'campaigns.statusRunning',
  completed: 'campaigns.statusCompleted',
  cancelled: 'campaigns.statusCancelled',
  failed: 'campaigns.statusFailed',
};

const DEFAULTS = {
  burstSize: 30,
  cooldownMinMs: 240000,
  cooldownMaxMs: 480000,
};

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * The per-session burst queue. Renders the divided plan: session A sends bursts of N messages with
 * a cooldown between bursts; sessions rotate round-robin (burst 1 of every session, then burst 2, …).
 */
function BurstSchedule({ distribution, strategy }: { distribution?: OutreachSessionAllocation[] | null; strategy?: OutreachCampaign['strategy'] | null }) {
  const { t } = useTranslation();
  if (!distribution || distribution.length === 0) {
    return <div className="campaigns-empty">{t('campaigns.noSchedule')}</div>;
  }
  const cooldownMin = strategy?.cooldownMinMs ?? DEFAULTS.cooldownMinMs;
  const cooldownMax = strategy?.cooldownMaxMs ?? DEFAULTS.cooldownMaxMs;

  return (
    <div className="campaigns-schedule">
      <p className="campaigns-note">{t('campaigns.roundRobinNote')}</p>
      <div className="campaigns-lanes">
        {distribution.map(session => (
          <div key={session.sessionId} className="campaigns-lane">
            <div className="campaigns-lane__head">
              <span className="campaigns-lane__name">{session.sessionName}</span>
              <span className="campaigns-lane__sub">{session.assigned} {t('campaigns.contacts')}</span>
            </div>
            <div className="campaigns-lane__body">
              {session.bursts?.length
                ? session.bursts.map(b => (
                    <div key={b.burstIndex} className="campaigns-burst">
                      <div className="campaigns-burst__badge">
                        {t('campaigns.burst', { n: b.burstIndex + 1 })}
                      </div>
                      <div className="campaigns-burst__count">{t('campaigns.msg', { n: b.contacts.length })}</div>
                      <div className="campaigns-burst__rest">
                        <Clock size={12} /> {t('campaigns.rest')}
                        <span className="campaigns-burst__restdetail">
                          {t('campaigns.restDetail', {
                            min: Math.round(cooldownMin / 60000),
                            max: Math.round(cooldownMax / 60000),
                          })}
                        </span>
                      </div>
                    </div>
                  ))
                : session.contacts.length > 0 && (
                    <div className="campaigns-burst">
                      <div className="campaigns-burst__badge">{t('campaigns.burst', { n: 1 })}</div>
                      <div className="campaigns-burst__count">{t('campaigns.msg', { n: session.contacts.length })}</div>
                      <div className="campaigns-burst__rest">
                        <Clock size={12} /> {t('campaigns.rest')}
                      </div>
                    </div>
                  )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const total = Math.ceil(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function formatElapsed(start: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Live dispatch timeline for a running/just-finished campaign. Ticks every second to show an elapsed
 * timer, per-session live status (burst in flight or cooldown countdown), and a burst-by-burst
 * history with per-burst sent counts so the operator sees messages actually going out.
 */
function CampaignLiveView({
  campaign,
  execution,
}: {
  campaign: OutreachCampaign;
  execution?: OutreachCampaignExecution | null;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  const running = campaign.status === 'running';
  const startedMs = campaign.startedAt ? new Date(campaign.startedAt).getTime() : 0;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const liveSessions = execution?.live?.sessions ?? [];
  const liveBySession = new Map<string, OutreachLiveSession>(liveSessions.map(s => [s.sessionName, s]));
  const sent = (execution?.sessionProgress ?? campaign.sessionProgress ?? []).reduce(
    (a, p) => a + (p.sent ?? 0), 0,
  );
  const failed = (execution?.sessionProgress ?? campaign.sessionProgress ?? []).reduce(
    (a, p) => a + (p.failed ?? 0), 0,
  );
  const total = execution?.sessionProgress?.reduce((a, p) => a + (p.total ?? 0), 0)
    ?? campaign.contactCount;

  return (
    <div className="campaigns-live">
      <div className="campaigns-live__header">
        <div className="campaigns-live__elapsed">
          <Clock size={14} />
          <span className="campaigns-live__elapsed-label">{t('campaigns.elapsed')}</span>
          <span className="campaigns-live__elapsed-value">
            {startedMs ? formatElapsed(startedMs, now) : '0:00'}
          </span>
        </div>
        <div className="campaigns-live__totals">
          <span className="campaigns-live__total-sent">{sent}/{total} {t('campaigns.sentTotal')}</span>
          <span className="campaigns-live__total-failed">{failed} {t('campaigns.failed')}</span>
          <span className="campaigns-live__pct">{total > 0 ? Math.round((sent / total) * 100) : 0}%</span>
        </div>
      </div>

      {(campaign.distribution ?? []).map(session => {
        const live = liveBySession.get(session.sessionName);
        const sentByBurst = new Map<string, number>();
        for (const b of execution?.batches ?? []) {
          if (b.sessionName !== session.sessionName) continue;
          const idx = /oc-[0-9a-f]{8}-[0-9a-f]{6}-(\d+)/.exec(b.batchId);
          const burstIdx = idx ? Number(idx[1]) : sentByBurst.size;
          sentByBurst.set(String(burstIdx), b.progress?.sent ?? 0);
        }
        const countdown =
          live && !live.inFlight && live.nextAvailableAt > now
            ? live.nextAvailableAt - now
            : 0;

        return (
          <div key={session.sessionId} className="campaigns-live__session">
            <div className="campaigns-live__session-head">
              <span className="campaigns-live__session-name">{session.sessionName}</span>
              {live ? (
                live.inFlight ? (
                  <span className="campaigns-live__badge campaigns-live__badge--sending">
                    {t('campaigns.sending')}
                  </span>
                ) : live.nextBurstIndex >= live.totalBursts && live.totalBursts > 0 ? (
                  <span className="campaigns-live__badge campaigns-live__badge--done">
                    {t('campaigns.allSessionsDone')}
                  </span>
                ) : (
                  <span className="campaigns-live__badge campaigns-live__badge--cooldown">
                    {t('campaigns.nextBurstIn', { time: formatCountdown(countdown) })}
                  </span>
                )
              ) : (
                <span className="campaigns-live__badge campaigns-live__badge--cooldown">—</span>
              )}
            </div>

            {session.bursts?.length ? (
              <div className="campaigns-live__bursts">
                {session.bursts.map((b, i) => {
                  const done = live ? i < live.nextBurstIndex : true;
                  const active = live ? i === live.nextBurstIndex && live.inFlight : false;
                  const count = sentByBurst.get(String(i)) ?? (done ? b.contacts.length : 0);
                  return (
                    <div
                      key={b.burstIndex}
                      className={`campaigns-live__burst${done ? ' is-done' : ''}${active ? ' is-active' : ''}`}
                      title={`Burst ${i + 1}`}
                    >
                      <span className="campaigns-live__burst-num">{i + 1}</span>
                      <span className="campaigns-live__burst-count">{count}/{b.contacts.length}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Polls the execution report for a single campaign and renders its live dispatch timeline. */
function CampaignLiveViewWithData({
  campaign,
}: {
  campaign: OutreachCampaign;
}) {
  const shouldPoll = campaign.status === 'running';
  const { data: execution } = useOutreachExecutionQuery(campaign.id, shouldPoll || campaign.status === 'completed');
  return <CampaignLiveView campaign={campaign} execution={execution} />;
}

export function Campaigns() {
  const { t } = useTranslation();
  useDocumentTitle(t('campaigns.title'));
  const { canWrite } = useRole();
  const toast = useToast();

  const { data: campaigns = [], isLoading } = useOutreachQuery();
  const { data: registryContacts = [] } = useRegistryContactsQuery(2000);
  const { data: replies = [] } = useRegistryRepliesQuery();
  const { data: sessions = [] } = useSessionsQuery();
  const readySessions = useMemo(() => sessions.filter(s => s.status === 'ready'), [sessions]);

  const createMutation = useCreateOutreachMutation();
  const actionMutation = useOutreachActionMutation();
  const deleteMutation = useOutreachDeleteMutation();

  // Create modal state
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [useRegistry, setUseRegistry] = useState(true);
  const [customList, setCustomList] = useState('');
  const [selectedSessions, setSelectedSessions] = useState<string[]>(readySessions.map(s => s.name));
  const [burstSize, setBurstSize] = useState(DEFAULTS.burstSize);
  const [cooldownMin, setCooldownMin] = useState(DEFAULTS.cooldownMinMs);
  const [cooldownMax, setCooldownMax] = useState(DEFAULTS.cooldownMaxMs);
  const [maxPerSession, setMaxPerSession] = useState('');
  const [saveContactFirst, setSaveContactFirst] = useState(true);

  const replyBySession = useMemo(() => {
    const map = new Map<string, { replied: number; sent: number; blocked: number; reported: number }>();
    for (const r of replies) map.set(r.sessionName, r);
    return map;
  }, [replies]);

  const toggleSession = (name: string) => {
    setSelectedSessions(prev =>
      prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name],
    );
  };

  const parseCustom = (): { phone: string; name?: string }[] => {
    const seen = new Set<string>();
    const items: { phone: string; name?: string }[] = [];
    for (const line of customList.split(/\r?\n/)) {
      const parts = line.split(',').map(p => p.trim());
      const digits = (parts[0] ?? '').replace(/[^0-9]/g, '');
      if (!digits || /[a-zA-Z]/.test(parts[0] ?? '') || seen.has(digits)) continue;
      if (digits.length < 5 || digits.length > 15) continue;
      seen.add(digits);
      items.push({ phone: digits, name: parts[1] || undefined });
    }
    return items;
  };

  const handleCreate = () => {
    if (!name.trim() || !message.trim()) {
      toast.warning(t('campaigns.toasts.actionFailed'));
      return;
    }
    if (selectedSessions.length === 0) {
      toast.warning(t('campaigns.toasts.actionFailed'));
      return;
    }
    const contacts = useRegistry
      ? registryContacts.map(c => ({ phone: c.phone, name: c.name || undefined }))
      : parseCustom();
    if (contacts.length === 0) {
      toast.warning(t('campaigns.toasts.actionFailed'));
      return;
    }

    createMutation.mutate(
      {
        name: name.trim(),
        messageText: message.trim(),
        contacts,
        sessions: selectedSessions.map(sessionName => ({ sessionName })),
        strategy: {
          burstSize,
          cooldownMinMs: cooldownMin,
          cooldownMaxMs: cooldownMax,
          preCheckNumbers: true,
          saveContactFirst,
          ...(maxPerSession ? { maxPerSessionPerDay: Number(maxPerSession) } : {}),
        },
      },
      {
        onSuccess: () => {
          toast.success(t('campaigns.toasts.created'));
          setShowCreate(false);
          setName('');
          setMessage('');
          setCustomList('');
        },
        onError: err => toast.error(t('campaigns.toasts.actionFailed'), (err as Error).message),
      },
    );
  };

  const handleAction = (campaign: OutreachCampaign, action: 'start' | 'stop') => {
    actionMutation.mutate(
      { action, id: campaign.id },
      {
        onSuccess: () => toast.success(t(`campaigns.toasts.${action === 'start' ? 'started' : 'stopped'}`)),
        onError: err => toast.error(t('campaigns.toasts.actionFailed'), (err as Error).message),
      },
    );
  };

  const handleDelete = (campaign: OutreachCampaign) => {
    deleteMutation.mutate(campaign.id, {
      onSuccess: () => toast.success(t('campaigns.toasts.deleted')),
      onError: err => toast.error(t('campaigns.toasts.actionFailed'), (err as Error).message),
    });
  };

  return (
    <div className="campaigns-page">
      <PageHeader
        title={t('campaigns.title')}
        subtitle={t('campaigns.subtitle')}
        actions={
          canWrite ? (
            <button className="btn-primary" onClick={() => setShowCreate(true)}>
              <Plus size={16} /> {t('campaigns.newCampaign')}
            </button>
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="campaigns-loading">
          <Loader2 className="spin-slow" size={24} />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="campaigns-empty-page">
          <Workflow size={32} />
          <p>{t('campaigns.empty')}</p>
        </div>
      ) : (
        <div className="campaigns-list">
          {campaigns.map(c => {
            const stats = c.sessionProgress?.reduce(
              (acc, p) => ({ sent: acc.sent + p.sent, failed: acc.failed + p.failed, pending: acc.pending + p.pending }),
              { sent: 0, failed: 0, pending: 0 },
            ) ?? { sent: 0, failed: 0, pending: 0 };
            return (
              <section key={c.id} className="campaigns-card">
                <header className="campaigns-card__head">
                  <div>
                    <h2 className="campaigns-card__name">{c.name}</h2>
                    <span className={`campaigns-status campaigns-status--${c.status}`}>{t(STATUS_LABEL[c.status] ?? c.status)}</span>
                  </div>
                  <div className="campaigns-card__facts">
                    <span>{c.contactCount} {t('campaigns.contacts')}</span>
                    <span>{c.sessionCount} {t('campaigns.sessions')}</span>
                    <span>{c.strategy?.burstSize} {t('campaigns.burstSize')}</span>
                    {c.strategy?.cooldownMinMs != null && (
                      <span>
                        {t('campaigns.cooldown')} {formatMs(c.strategy.cooldownMinMs)}–{formatMs(c.strategy.cooldownMaxMs ?? c.strategy.cooldownMinMs)}
                      </span>
                    )}
                    {c.strategy?.maxPerSessionPerDay && <span>max {c.strategy.maxPerSessionPerDay}/sess</span>}
                    <span className="campaigns-sendstats">
                      <Activity size={13} /> {stats.sent} {t('campaigns.sentTotal')} · {stats.pending} {t('campaigns.pending')} · {stats.failed} {t('campaigns.failed')}
                    </span>
                  </div>
                  {canWrite && (
                    <div className="campaigns-card__actions">
                      {c.status === 'scheduled' && (
                        <button className="btn-secondary" onClick={() => handleAction(c, 'start')}>
                          <Play size={15} /> {t('campaigns.start')}
                        </button>
                      )}
                      {c.status === 'running' && (
                        <button className="btn-secondary" onClick={() => handleAction(c, 'stop')}>
                          <Pause size={15} /> {t('campaigns.stop')}
                        </button>
                      )}
                      {(c.status === 'completed' || c.status === 'cancelled' || c.status === 'failed') && (
                        <>
                          <button className="btn-secondary" onClick={() => handleAction(c, 'start')} title={t('campaigns.restart')}>
                            <Play size={15} /> {t('campaigns.restart')}
                          </button>
                          <button style={{backgroundColor: 'red'}} onClick={() => handleDelete(c)} title={t('campaigns.delete')}>
                            {/* <Trash2 size={15} /> */}
                            {t('campaigns.delete')}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </header>

                <div className="campaigns-card__message">{c.messageText}</div>

                <BurstSchedule distribution={c.distribution} strategy={c.strategy} />

                {(c.status === 'running' || c.status === 'completed') && (
                  <CampaignLiveViewWithData campaign={c} />
                )}

                {(c.sessionProgress?.length ?? 0) > 0 && (
                  <div className="campaigns-progress">
                    {c.sessionProgress?.map(p => {
                      const rr = replyBySession.get(p.sessionName);
                      const barPct = p.total > 0 ? ((p.sent + p.failed) / p.total) * 100 : 0;
                      return (
                        <div key={p.sessionId} className="campaigns-progress__row">
                          <span className="campaigns-progress__name">{p.sessionName}</span>
                          <div className="campaigns-progress__track">
                            <div className="campaigns-progress__fill" style={{ width: `${barPct}%` }} />
                          </div>
                          <span className="campaigns-progress__nums">
                            {p.sent}/{p.total} {t('campaigns.sentTotal')}
                          </span>
                          <span className="campaigns-progress__reply">
                            {rr ? `${rr.replied} ${t('campaigns.replied')} · ${Math.round(rr.sent > 0 ? (rr.replied / rr.sent) * 100 : 0)}%` : ''}
                            {rr && (rr.blocked > 0 || rr.reported > 0) ? ` · B/R ${rr.blocked + rr.reported}` : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={t('campaigns.create.title')}
        className="campaigns-create-modal"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setShowCreate(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn-primary" onClick={handleCreate} disabled={createMutation.isPending || !canWrite}>
              {createMutation.isPending ? <Loader2 className="spin-slow" size={16} /> : <Plus size={16} />}{' '}
              {t('campaigns.create.create')}
            </button>
          </>
        }
      >
        <div className="campaigns-form">
          <label className="campaigns-field">
            <span>{t('campaigns.create.name')}</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="wave-1" />
          </label>
          <label className="campaigns-field">
            <span>{t('campaigns.create.message')}</span>
            <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} placeholder="Hi {{name}}…" />
            <small>{t('campaigns.create.messageHint')}</small>
          </label>

          <label className="campaigns-check">
            <input type="checkbox" checked={useRegistry} onChange={e => setUseRegistry(e.target.checked)} />
            {t('campaigns.create.fromRegistry')}
          </label>
          <small className="campaigns-hint">{t('campaigns.create.fromRegistryHint')}</small>
          {useRegistry ? (
            <div className="campaigns-field">
              <span className="campaigns-count">{t('campaigns.create.ledCount', { count: registryContacts.length })}</span>
            </div>
          ) : (
            <label className="campaigns-field">
              <span>{t('campaigns.create.customList')}</span>
              <textarea value={customList} onChange={e => setCustomList(e.target.value)} rows={4} placeholder="628123456789, Alice&#10;628987654321" />
            </label>
          )}

          <div className="campaigns-field">
            <span>{t('campaigns.create.sessionsLabel')}</span>
            <div className="campaigns-sessionpool">
              {readySessions.length === 0 ? (
                <small>—</small>
              ) : (
                readySessions.map(s => (
                  <label key={s.id} className="campaigns-sessionpool__item">
                    <input type="checkbox" checked={selectedSessions.includes(s.name)} onChange={() => toggleSession(s.name)} />
                    {s.name}
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="campaigns-form__row">
            <label className="campaigns-field">
              <span>{t('campaigns.create.burstSize')}</span>
              <input type="number" min={1} value={burstSize} onChange={e => setBurstSize(Number(e.target.value) || 1)} />
            </label>
            <label className="campaigns-field">
              <span>{t('campaigns.create.maxPerSession')}</span>
              <input type="number" min={1} value={maxPerSession} onChange={e => setMaxPerSession(e.target.value)} placeholder="715" />
            </label>
          </div>
          <div className="campaigns-form__row">
            <label className="campaigns-field">
              <span>{t('campaigns.create.cooldownMin')}</span>
              <input type="number" min={0} step={1000} value={cooldownMin} onChange={e => setCooldownMin(Number(e.target.value) || 0)} />
            </label>
            <label className="campaigns-field">
              <span>{t('campaigns.create.cooldownMax')}</span>
              <input type="number" min={0} step={1000} value={cooldownMax} onChange={e => setCooldownMax(Number(e.target.value) || 0)} />
            </label>
          </div>
          <label className="campaigns-check">
            <input type="checkbox" checked={saveContactFirst} onChange={e => setSaveContactFirst(e.target.checked)} />
            {t('campaigns.create.saveContactFirst')}
          </label>
        </div>
      </Modal>
    </div>
  );
}