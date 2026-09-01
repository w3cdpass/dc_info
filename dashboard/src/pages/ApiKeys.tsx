import { useState, useEffect, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  useTable,
  tableFeatures,
  createColumnHelper,
  createCoreRowModel,
  columnVisibilityFeature,
  flexRender,
  type ColumnVisibilityState,
} from '@tanstack/react-table';
import {
  Plus,
  Copy,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  Loader2,
  Check,
  KeyRound,
  AlertTriangle,
  AlertCircle,
  Coins,
  Edit2,
} from 'lucide-react';
import type { ApiKey } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useApiKeysQuery,
  useCreateApiKeyMutation,
  useDeleteApiKeyMutation,
  useRevokeApiKeyMutation,
  useCreditTemplatesQuery,
  useCreateCreditTemplateMutation,
  useUpdateCreditTemplateMutation,
  useDeleteCreditTemplateMutation,
  useAddCreditsMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import { copyToClipboard } from '../utils/clipboard';
import './ApiKeys.css';

const roleNames = ['admin', 'operator', 'viewer', 'demo'] as const;

function useWindowSize() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return width;
}

const features = tableFeatures({
  columnVisibilityFeature,
  coreRowModel: createCoreRowModel(),
});

const columnHelper = createColumnHelper<typeof features, ApiKey>();

export function ApiKeys() {
  const { t } = useTranslation();
  const toast = useToast();
  useDocumentTitle(t('apiKeys.title'));
  const { data: apiKeys = [], isLoading: loading, isError: apiKeysError } = useApiKeysQuery();
  const { data: creditTemplates = [] } = useCreditTemplatesQuery();
  const createMutation = useCreateApiKeyMutation();
  const deleteMutation = useDeleteApiKeyMutation();
  const revokeMutation = useRevokeApiKeyMutation();
  const createTemplateMutation = useCreateCreditTemplateMutation();
  const updateTemplateMutation = useUpdateCreditTemplateMutation();
  const deleteTemplateMutation = useDeleteCreditTemplateMutation();
  const addCreditsMutation = useAddCreditsMutation();
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [newKey, setNewKey] = useState({ name: '', role: 'demo' as string, credits: '100', textCost: '1', imageCost: '2', docCost: '2', email: '', password: '' });
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: 'delete' | 'revoke'; id: string; name: string } | null>(null);
  const [creditModal, setCreditModal] = useState<{ id: string; name: string } | null>(null);
  const [addAmount, setAddAmount] = useState('50');
  const [templateModal, setTemplateModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<any | null>(null);
  const [tplForm, setTplForm] = useState({ name: '', body: `Hey! 👋 Kamal here from **Infyle Technologies** 😊\n\nAre you planning to build or upgrade anything tech-related for your business? 🚀\n\nWe can help with:\n🌐 Websites — ₹15K onwards\n📱 Mobile Apps — ₹35K onwards\n💻 CRM / Custom Software — ₹40K onwards\n🤖 AI Solutions — ₹50K onwards\n\nHave an idea in mind? Just reply **"Hi"** and I'll share some relevant work + pricing. 😊\n\nLet's build something awesome! 🚀`, type: 'text', creditCost: '1' });

  const windowWidth = useWindowSize();
  const isMobile = windowWidth < 768;
  const isSmall = windowWidth < 640;
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});

  useEffect(() => {
    setColumnVisibility({ key: !isSmall, lastUsed: !isMobile });
  }, [isMobile, isSmall]);

  const isSuperAdmin = (() => {
    try { return (sessionStorage.getItem('openwa_admin_email') || '').toLowerCase() === 'infyle@infyle.com'; } catch { return false; }
  })();

  const availableRoles = isSuperAdmin ? roleNames : (['operator', 'viewer', 'demo'] as const);

  const handleCreate = async () => {
    if (!newKey.name) return;
    if (newKey.role === 'demo' && (!newKey.email || !newKey.password)) {
      toast.error('Demo user requires email and password for username/password login');
      return;
    }
    if (!isSuperAdmin && newKey.role === 'admin') {
      toast.error('Only main admin (infyle@infyle.com) can create admin users');
      return;
    }
    try {
      if (newKey.role === 'demo') {
        // Demo with username/password -> use reseller endpoint (creates both reseller user + api key)
        const res = await fetch('/api/auth/reseller/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': sessionStorage.getItem('openwa_api_key') || '',
            'X-Admin-Email': sessionStorage.getItem('openwa_admin_email') || 'infyle@infyle.com',
          },
          body: JSON.stringify({
            email: newKey.email.trim().toLowerCase(),
            password: newKey.password,
            role: 'demo',
            name: newKey.name,
            credits: Number(newKey.credits) || 0,
            creditCost: {
              text: Number(newKey.textCost) || 1,
              image: Number(newKey.imageCost) || 2,
              document: Number(newKey.docCost) || 2,
              video: Number(newKey.imageCost) || 2,
              campaign: Number(newKey.textCost) || 1,
              default: Number(newKey.textCost) || 1,
            },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || 'Failed to create demo user');
        setCreatedKey(data.apiKey || null);
        toast.success(`Demo user ${newKey.email} created — can login with username/password`);
      } else {
        const payload: any = { name: newKey.name, role: newKey.role };
        const created = await createMutation.mutateAsync(payload);
        setCreatedKey(created.apiKey || null);
      }
      setNewKey({ name: '', role: 'demo', credits: '100', textCost: '1', imageCost: '2', docCost: '2', email: '', password: '' });
    } catch (err) {
      toast.error(t('apiKeys.createBtn'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const handleRevoke = async (id: string) => {
    try { await revokeMutation.mutateAsync(id); } catch (err) { toast.error(t('apiKeys.actions.revoke'), err instanceof Error ? err.message : t('common.unknownError')); }
  };
  const handleDelete = async (id: string) => {
    try { await deleteMutation.mutateAsync(id); } catch (err) { toast.error(t('apiKeys.actions.delete'), err instanceof Error ? err.message : t('common.unknownError')); }
  };
  const confirmAndExecute = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'delete') handleDelete(confirmAction.id);
    else handleRevoke(confirmAction.id);
    setConfirmAction(null);
  };
  const toggleKeyVisibility = (id: string) => {
    setVisibleKeys(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const handleCopy = async (text: string, id: string) => {
    if (await copyToClipboard(text)) { setCopied(id); setTimeout(() => setCopied(null), 2000); }
  };

  const handleAddCredits = async () => {
    if (!creditModal) return;
    try {
      await addCreditsMutation.mutateAsync({ id: creditModal.id, amount: Number(addAmount) || 0 });
      toast.success(`Added ${addAmount} credits to ${creditModal.name}`);
      setCreditModal(null);
    } catch (e) { toast.error('Failed to add credits', (e as Error).message); }
  };

  const handleCreateTemplate = async () => {
    try {
      if (editingTemplate) {
        await updateTemplateMutation.mutateAsync({ id: editingTemplate.id, data: { name: tplForm.name, body: tplForm.body, creditCost: Number(tplForm.creditCost) } as any });
        toast.success('Template updated');
      } else {
        await createTemplateMutation.mutateAsync({ name: tplForm.name || 'New Template', body: tplForm.body, type: tplForm.type, creditCost: Number(tplForm.creditCost) || 1 });
        toast.success('Template created');
      }
      setTemplateModal(false);
      setEditingTemplate(null);
    } catch (e) { toast.error('Failed', (e as Error).message); }
  };

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor('name', {
          header: () => t('apiKeys.columns.name'),
          cell: info => <span className="name-cell">{info.getValue()}</span>,
        }),
        columnHelper.accessor('keyPrefix', {
          id: 'key',
          header: () => t('apiKeys.columns.key'),
          cell: info => {
            const apiKey = info.row.original;
            return (
              <span className="key-cell">
                <code>{visibleKeys.has(apiKey.id) ? apiKey.keyPrefix + '...' : apiKey.keyPrefix + '****'}</code>
                <button className="icon-btn-sm" onClick={() => toggleKeyVisibility(apiKey.id)} aria-label={visibleKeys.has(apiKey.id) ? t('common.hideApiKey') : t('common.showApiKey')}>
                  {visibleKeys.has(apiKey.id) ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </span>
            );
          },
        }),
        columnHelper.accessor('role', {
          header: () => t('apiKeys.columns.role'),
          cell: info => <span className="permission-badge">{info.getValue()}</span>,
        }),
        columnHelper.display({
          id: 'credits',
          header: () => 'Credits',
          cell: info => {
            const k = info.row.original as any;
            if (k.role !== 'demo') return <span style={{ color: '#94a3b8' }}>—</span>;
            const remaining = k.credits != null ? (k.credits - (k.creditsUsed || 0)) : null;
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Coins size={14} /> {k.creditsUsed || 0}/{k.credits ?? '∞'} {remaining != null && <small style={{ color: remaining < 10 ? '#ef4444' : '#64748b' }}>({remaining} left)</small>}
              </span>
            );
          },
        }),
        columnHelper.accessor('isActive', {
          header: () => t('apiKeys.columns.status'),
          cell: info => (
            <span className={`status-badge ${info.getValue() ? 'active' : 'inactive'}`}>
              {info.getValue() ? t('apiKeys.statuses.active') : t('apiKeys.statuses.revoked')}
            </span>
          ),
        }),
        columnHelper.accessor('lastUsedAt', {
          id: 'lastUsed',
          header: () => t('apiKeys.columns.lastUsed'),
          cell: info => <span className="last-used">{info.getValue() ? new Date(info.getValue()!).toLocaleDateString() : t('common.never')}</span>,
        }),
        columnHelper.display({
          id: 'actions',
          header: () => t('apiKeys.columns.actions'),
          cell: info => {
            const apiKey = info.row.original;
            return (
              <span className="actions-cell">
                {apiKey.isActive && (apiKey as any).role === 'demo' && (
                  <button className="icon-btn" onClick={() => setCreditModal({ id: apiKey.id, name: apiKey.name })} title="Add Credits"><Coins size={16} /></button>
                )}
                {apiKey.isActive && (
                  <button className="icon-btn" onClick={() => setConfirmAction({ type: 'revoke', id: apiKey.id, name: apiKey.name })} title={t('apiKeys.actions.revoke')}><RefreshCw size={16} /></button>
                )}
                <button className="icon-btn danger" onClick={() => setConfirmAction({ type: 'delete', id: apiKey.id, name: apiKey.name })} title={t('apiKeys.actions.delete')}><Trash2 size={16} /></button>
              </span>
            );
          },
        }),
      ]),
    [visibleKeys, t],
  );

  const table = useTable({ features, data: apiKeys, columns, state: { columnVisibility }, onColumnVisibilityChange: setColumnVisibility });

  if (loading) {
    return <div className="api-keys-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}><Loader2 className="animate-spin" size={32} /></div>;
  }

  return (
    <div className="api-keys-page">
      <PageHeader
        title={t('apiKeys.title')}
        subtitle={t('apiKeys.subtitle')}
        actions={<>
          <button className="btn-secondary" onClick={() => { setTplForm({ name: '', body: '', type: 'text', creditCost: '1' }); setEditingTemplate(null); setTemplateModal(true); }}><Edit2 size={16} /> Manage Message Credits</button>
          <button className="btn-primary" onClick={() => setShowModal(true)}><Plus size={18} />{t('apiKeys.createBtn')}</button>
        </>}
      />

      {apiKeysError && <div className="error-banner" role="alert"><AlertCircle size={20} /><span className="error-banner-text">{t('dashboard.loadError')}</span></div>}

      {/* Credit Templates - admin editable per-message credit */}
      <div className="credit-templates-panel">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Coins size={18} /> Message Credit Costs (admin editable)</h3>
        <p style={{ fontSize: 13, color: '#64748b' }}>Each message type has its own credit cost. Text=1, Image/PDF=2 by default. Admin can edit content and cost; demo users consume credits per send.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12, marginTop: 12 }}>
          {creditTemplates.map((tpl: any) => (
            <div key={tpl.id} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, background: '#333' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{tpl.name} <small style={{ color: '#64748b' }}>{tpl.type}</small></strong>
                <span style={{ background: 'gray', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}><Coins size={12} /> {tpl.creditCost} credits</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 13, whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto', background: 'grey', padding: 8, borderRadius: 6 }}>{tpl.body.slice(0, 200)}{tpl.body.length > 200 ? '…' : ''}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => { setEditingTemplate(tpl); setTplForm({ name: tpl.name, body: tpl.body, type: tpl.type, creditCost: String(tpl.creditCost) }); setTemplateModal(true); }}><Edit2 size={12} /> Edit</button>
                <button className="btn-danger" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => deleteTemplateMutation.mutate(tpl.id)}><Trash2 size={12} /> Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showModal && (
        <Modal open onClose={() => { setShowModal(false); setCreatedKey(null); }} title={createdKey ? t('apiKeys.createdTitle') : t('apiKeys.modalTitle')} closeLabel={t('common.close')}
          footer={!createdKey ? <>
            <button className="btn-secondary" onClick={() => setShowModal(false)}>{t('common.cancel')}</button>
            <button className="btn-primary" onClick={handleCreate} disabled={createMutation.isPending || !newKey.name}>{createMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}</button>
          </> : undefined}
        >
          {createdKey ? (
            <div>
              <p style={{ marginBottom: '1rem', color: 'var(--text-muted)' }}>{t('apiKeys.createdHint')}</p>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <code style={{ flex: 1, padding: '0.75rem', background: 'var(--bg-secondary)', borderRadius: '6px', wordBreak: 'break-all' }}>{createdKey}</code>
                <button className="btn-primary" onClick={() => void handleCopy(createdKey, 'modal')}>{copied === 'modal' ? <Check size={16} /> : <Copy size={16} />}</button>
              </div>
            </div>
          ) : (
            <>
              <label htmlFor="ak-1">{t('common.name')}</label>
              <input id="ak-1" type="text" placeholder={t('apiKeys.namePlaceholder')} value={newKey.name} onChange={e => setNewKey({ ...newKey, name: e.target.value })} />
              <label htmlFor="ak-2">{t('common.role')}</label>
              <select id="ak-2" value={newKey.role} onChange={e => setNewKey({ ...newKey, role: e.target.value })}>
                {availableRoles.map(r => <option key={r} value={r}>{t(`apiKeys.roles.${r}`) ?? r}</option>)}
                {!availableRoles.includes('demo' as any) && <option value="demo">demo</option>}
              </select>
              {!isSuperAdmin && newKey.role === 'admin' && <small style={{ color: '#ef4444' }}>Only infyle@infyle.com can create admin</small>}
              {newKey.role === 'demo' && (
                <div style={{ marginTop: 12, padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label>Demo email (username for login)</label>
                  <input type="email" value={newKey.email} onChange={e => setNewKey({ ...newKey, email: e.target.value })} placeholder="demo@example.com" />
                  <label>Password (for email login)</label>
                  <input type="password" value={newKey.password} onChange={e => setNewKey({ ...newKey, password: e.target.value })} placeholder="••••••••" />
                  <small style={{ color: '#64748b' }}>Demo will login via <b>Admin Login</b> tab using this email/password (same as infyle@infyle.com) — no API key paste needed.</small>
                  <label>Credits to allocate</label>
                  <input type="number" value={newKey.credits} onChange={e => setNewKey({ ...newKey, credits: e.target.value })} placeholder="100" />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
                    <label>Text cost<input type="number" value={newKey.textCost} onChange={e => setNewKey({ ...newKey, textCost: e.target.value })} /></label>
                    <label>Image cost<input type="number" value={newKey.imageCost} onChange={e => setNewKey({ ...newKey, imageCost: e.target.value })} /></label>
                    <label>File/PDF cost<input type="number" value={newKey.docCost} onChange={e => setNewKey({ ...newKey, docCost: e.target.value })} /></label>
                  </div>
                  <small style={{ color: '#64748b' }}>Usage shown per demo: sent vs remaining per message type.</small>
                </div>
              )}
            </>
          )}
        </Modal>
      )}

      {creditModal && (
        <Modal open onClose={() => setCreditModal(null)} title={`Add Credits — ${creditModal.name}`}>
          <label>Amount to add</label>
          <input type="number" value={addAmount} onChange={e => setAddAmount(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn-secondary" onClick={() => setCreditModal(null)}>{t('common.cancel')}</button>
            <button className="btn-primary" onClick={handleAddCredits} disabled={addCreditsMutation.isPending}><Coins size={14} /> Add</button>
          </div>
        </Modal>
      )}

      {templateModal && (
        <Modal open onClose={() => { setTemplateModal(false); setEditingTemplate(null); }} title={editingTemplate ? 'Edit Message' : 'Create Message Template'}>
          <label>Name</label><input value={tplForm.name} onChange={e => setTplForm({ ...tplForm, name: e.target.value })} placeholder="Default Text" />
          <label>Type</label>
          <select value={tplForm.type} onChange={e => setTplForm({ ...tplForm, type: e.target.value })}>
            <option value="text">Text (1 credit)</option>
            <option value="image">Image (+file) (2 credits)</option>
            <option value="document">File/PDF (2 credits)</option>
            <option value="video">Video</option>
          </select>
          <label>Body (editable by admin)</label>
          <textarea rows={6} value={tplForm.body} onChange={e => setTplForm({ ...tplForm, body: e.target.value })} />
          <label>Credit cost for this message</label><input type="number" value={tplForm.creditCost} onChange={e => setTplForm({ ...tplForm, creditCost: e.target.value })} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn-secondary" onClick={() => setTemplateModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleCreateTemplate}>{editingTemplate ? 'Update' : 'Create'}</button>
          </div>
        </Modal>
      )}

      <div className="api-keys-content">
        <div className="keys-table-container">
          {apiKeys.length === 0 ? (
            <div className="empty-table-state"><KeyRound size={48} strokeWidth={1} /><h3>{t('apiKeys.empty.title')}</h3><p>{t('apiKeys.empty.description')}</p></div>
          ) : (
            <table className="keys-table">
              <thead>{table.getHeaderGroups().map(headerGroup => (<tr key={headerGroup.id} className="table-row header">{headerGroup.headers.map(header => (<th key={header.id}>{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</th>))}</tr>))}</thead>
              <tbody>{table.getRowModel().rows.map(row => (<tr key={row.id} className="table-row">{row.getVisibleCells().map(cell => (<td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>))}</tr>))}</tbody>
            </table>
          )}
        </div>

        <div className="permissions-reference">
          <h3>{t('apiKeys.rolesTitle')}</h3>
          <div className="permissions-list">
            {roleNames.map(r => (<div key={r} className="perm-item"><code>{r}</code><span>{t(`apiKeys.roleDescriptions.${r}`) ?? (r==='demo' ? 'Demo — can only send messages, start campaigns, view stats' : '')}</span></div>))}
          </div>
          <div style={{ marginTop: 12, padding: 12, background: 'grey', borderRadius: 8, fontSize: 13 }}>
            <strong>Demo user panel:</strong> When you create a demo user with credits (e.g. 10 or 100), that user’s dashboard will only show <em>Message Tester</em>, <em>Campaigns</em> and <em>Dashboard stats</em>. Usage is tracked per message type (text/image/file) using the costs above.
          </div>
        </div>
      </div>

      {confirmAction && (
        <Modal open onClose={() => setConfirmAction(null)} title={confirmAction.type === 'delete' ? t('apiKeys.confirm.deleteTitle') : t('apiKeys.confirm.revokeTitle')} className="confirm-modal" closeLabel={t('common.close')}
          footer={<>
            <button className="btn-secondary" onClick={() => setConfirmAction(null)}>{t('common.cancel')}</button>
            <button className="btn-danger" onClick={confirmAndExecute}>{confirmAction.type === 'delete' ? t('apiKeys.confirm.delete') : t('apiKeys.confirm.revoke')}</button>
          </>}
        >
          <div className="confirm-icon-wrapper"><AlertTriangle size={48} className="confirm-warning-icon" /></div>
          <p className="confirm-message"><Trans i18nKey={confirmAction.type === 'delete' ? 'apiKeys.confirm.deleteMessage' : 'apiKeys.confirm.revokeMessage'} values={{ name: confirmAction.name }} components={{ strong: <strong /> }} /></p>
        </Modal>
      )}
    </div>
  );
}
