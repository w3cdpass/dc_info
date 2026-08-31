import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages, Mail, Lock, KeyRound } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { API_BASE_URL } from '../services/api';
import { getSupabase, HARDCODED_ADMIN } from '../lib/supabase';
import './Login.css';

interface LoginProps {
  onLogin: (apiKey: string, role?: string) => void;
}

export function Login({ onLogin }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<'admin' | 'apikey'>('admin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const handleAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError(t('login.emailPasswordRequired', 'Email and password are required'));
      return;
    }
    setIsLoading(true);
    setError('');

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPassword = password.trim();

    // 1) Hardcoded check — instant, no network needed (matches backend)
    const isHardcoded =
      normalizedEmail === HARDCODED_ADMIN.email.toLowerCase() &&
      normalizedPassword === HARDCODED_ADMIN.password;

    // 2) Try Supabase admin_users lookup for additional admins (best-effort)
    let isSupabaseAdmin = false;
    if (!isHardcoded) {
      try {
        const supabase = getSupabase();
        if (supabase) {
          const { data } = await supabase
            .from('admin_users')
            .select('email, password_hash, is_active')
            .eq('email', normalizedEmail)
            .eq('is_active', true)
            .maybeSingle();
          if (data) {
            const stored = (data as any).password_hash as string;
            if (stored === normalizedPassword) isSupabaseAdmin = true;
          }
        }
      } catch {
        // ignore — fall through to backend validation
      }
    }

    // If neither hardcoded nor supabase-admin, still try backend (it handles hashing/bcrypt)
    if (!isHardcoded && !isSupabaseAdmin) {
      // Let backend decide — it will return 401 if invalid
    } else {
      // We have a local match, but still go through backend to fetch the API key for subsequent calls
    }

    try {
      const res = await fetch(`${API_BASE_URL}/auth/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail, password: normalizedPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || t('login.invalidCredentials', 'Invalid email or password'));
        return;
      }
      // Backend returns { success, admin, apiKey }
      const returnedKey: string | null = data.apiKey || null;
      if (returnedKey) {
        onLogin(returnedKey, data.admin?.role || 'admin');
        sessionStorage.setItem('openwa_admin_email', data.admin?.email || normalizedEmail);
      } else {
        // No API key returned (e.g. no bootstrap file) — try to fallback to any stored key or ask user to use API key mode
        // Try to read existing stored key
        const existing = sessionStorage.getItem('openwa_api_key');
        if (existing) {
          onLogin(existing, data.admin?.role || 'admin');
        } else {
          // Store a marker so App knows admin is authenticated even without api key
          // and attempt to validate with empty key — will trigger API key prompt
          setError(
            t(
              'login.noApiKey',
              'Admin verified but no API key found. Please paste your API key below or check data/.api-key on server.',
            ),
          );
          setMode('apikey');
        }
      }
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleApiKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError(t('login.apiKeyRequired'));
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
      });
      if (response.ok) {
        const data: { role?: string } = await response.json().catch(() => ({}));
        onLogin(apiKey, data.role);
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.message || t('login.invalidKey'));
      }
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        {/* <div className="login-logo">
          <img src="/openwa_logo.webp" alt="OpenWA" className="logo-icon" />
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              date: new Date(__BUILD_TIME__).toISOString().slice(0, 10).replace(/-/g, ''),
            })}
          </span>
        </div> */}

        {/* <div className="login-language">
          <Languages size={18} />
          <CustomSelect
            value={currentLang}
            onChange={value => changeLanguage(value as SupportedLanguage)}
            options={languageOptions.map(opt => ({ value: opt.value, label: opt.label }))}
            ariaLabel={t('common.language')}
          />
        </div> */}

        <div className="login-tabs">
          <button
            type="button"
            className={`login-tab ${mode === 'admin' ? 'active' : ''}`}
            onClick={() => {
              setMode('admin');
              setError('');
            }}
          >
            <Mail size={14} /> Admin Login
          </button>
          <button
            type="button"
            className={`login-tab ${mode === 'apikey' ? 'active' : ''}`}
            onClick={() => {
              setMode('apikey');
              setError('');
            }}
          >
            <KeyRound size={14} /> API Key
          </button>
        </div>

        {mode === 'admin' ? (
          <form onSubmit={handleAdminSubmit} className="login-form">
            <div className="input-group">
              <label htmlFor="email">Email</label>
              <div className="input-wrapper">
                <Mail size={16} className="input-icon" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="infyle@infyle.com"
                  autoComplete="email"
                />
              </div>
            </div>
            <div className="input-group">
              <label htmlFor="password">Password</label>
              <div className="input-wrapper">
                <Lock size={16} className="input-icon" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className={error ? 'error' : ''}
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? t('common.hideApiKey') : t('common.showApiKey')}
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
              {error && <span className="error-message">{error}</span>}
              <span className="login-hint">Default: infyle@infyle.com / infyle@90 — also stored in Supabase admin_users</span>
            </div>
            <button type="submit" className="connect-btn" disabled={isLoading}>
              {isLoading ? t('login.connecting') : t('login.connect')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleApiKeySubmit} className="login-form">
            <div className="input-group">
              <label htmlFor="apiKey">{t('login.apiKey')}</label>
              <div className="input-wrapper">
                <input
                  id="apiKey"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={t('login.apiKeyPlaceholder')}
                  className={error ? 'error' : ''}
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={showKey ? t('common.hideApiKey') : t('common.showApiKey')}
                >
                  {showKey ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
              {error && <span className="error-message">{error}</span>}
            </div>
            <button type="submit" className="connect-btn" disabled={isLoading}>
              {isLoading ? t('login.connecting') : t('login.connect')}
            </button>
            <p className="login-hint">API key is still used for all data requests behind the scenes.</p>
          </form>
        )}

        {/* <p className="login-help">
          {t('login.help')}{' '}
          <a href="https://docs.open-wa.org" target="_blank" rel="noopener noreferrer">
            {t('login.viewDocs')}
          </a>
        </p> */}
      </div>

      {/* <footer className="login-footer">
        <span>{t('login.footer')}</span>
        <a
          href="https://github.com/rmyndharis/OpenWA"
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
          aria-label="GitHub"
        >
          <GithubIcon size={18} />
        </a>
      </footer> */}
    </div>
  );
}
