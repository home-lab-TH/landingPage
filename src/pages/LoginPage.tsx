import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ARCADE_GAMES,
  AVATAR_GLYPH,
  Icon,
  Login,
  PRIVILEGE_KEYS,
  PRIVILEGE_META,
  ROLE_META,
  apiJson,
  formatCountdown,
  formatDateTime,
  hasPriv,
  streetCredLevel,
} from '../lib';
import type { AuthUser } from '../lib';

type LoginPageProps = {
  user: AuthUser | null;
  pass: string;
  needsBootstrap?: boolean;
  allowLegacyPassword?: boolean;
  onLogin: (passOrToken: string, user?: AuthUser) => void;
  onLogout: () => Promise<void> | void;
  onRefreshAuth: () => Promise<void> | void;
};

export default function LoginPage({
  user,
  pass,
  needsBootstrap,
  allowLegacyPassword,
  onLogin,
  onLogout,
  onRefreshAuth,
}: LoginPageProps) {
  const [now, setNow] = useState(() => Date.now());
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwState, setPwState] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  const [pwMsg, setPwMsg] = useState('');
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!user?.expiresAt) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [user?.expiresAt]);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await onLogout();
    } finally {
      setSigningOut(false);
    }
  };

  const submitChangePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPwMsg('');
    if (newPassword !== confirmPassword) {
      setPwState('err');
      setPwMsg('New passwords do not match.');
      return;
    }
    setPwState('busy');
    try {
      await apiJson<{ ok: boolean }>('./api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      }, pass);
      setPwState('ok');
      setPwMsg('Password updated successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await onRefreshAuth();
    } catch (err) {
      setPwState('err');
      setPwMsg(err instanceof Error ? err.message : 'Unable to change password.');
    }
  };

  const roleInfo = user ? ROLE_META[user.role] : null;
  const expiry = user?.expiresAt ? formatCountdown(user.expiresAt, now) : null;
  const effectivePrivileges = user
    ? user.role === 'owner'
      ? [...PRIVILEGE_KEYS]
      : user.privileges
    : [];
  const cred = streetCredLevel(user?.xp ?? 0);
  const totalPlays = Object.values(user?.plays ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const combinedScore = Object.values(user?.scores ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const isLegacyOnly = !user && Boolean(pass) && pass !== '__sso__';

  return (
    <div className="login-page">
      <header className="page-head">
        <div>
          <p className="eyebrow"><Icon name="shield" className="icon-xs" />Single Sign-On</p>
          <h1>Homelab Access</h1>
          <p className="lede">Single Sign-On across Dashboard &amp; Cyber Arcade.</p>
        </div>
        {user && (
          <button type="button" className="btn" disabled={signingOut} onClick={() => void handleSignOut()}>
            <Icon name="logout" />{signingOut ? 'Signing out…' : 'Sign Out'}
          </button>
        )}
      </header>

      {user ? (
        <div className="login-session-grid">
          <section className="panel session-card">
            <div className="session-top">
              <div className="session-identity">
                <span className={`user-avatar role-${roleInfo?.cls ?? 'player'}`} aria-hidden="true">
                  {AVATAR_GLYPH[user.avatar] ?? '◈'}
                </span>
                <div>
                  <div className="session-title-row">
                    <h2>{user.displayName}</h2>
                    {roleInfo && <span className={`role-badge ${roleInfo.cls}`}>{roleInfo.label}</span>}
                    {user.isLegacy && <span className="pill">Legacy Token</span>}
                  </div>
                  <p className="mono dim">@{user.username}{user.note ? ` · ${user.note}` : ''}</p>
                </div>
              </div>
              {expiry && (
                <div className={`countdown-pill ${expiry.expired ? 'expired' : expiry.urgent ? 'urgent' : ''}`}>
                  <Icon name="clock" className="icon-xs" />
                  <span>{expiry.text}</span>
                  <small className="dim">({formatDateTime(user.expiresAt)})</small>
                </div>
              )}
            </div>

            <div className="quick-links">
              <a className="btn solid" href="#/"><Icon name="grid" />Overview</a>
              {hasPriv(user, 'manage_users') && (
                <a className="btn" href="#/users"><Icon name="users" />Users &amp; Audit</a>
              )}
              <a className="btn" href="/game/"><Icon name="gamepad" />Cyberpunk Game Hub</a>
              <button type="button" className="ghost" disabled={signingOut} onClick={() => void handleSignOut()}>
                <Icon name="logout" className="icon-xs" />Sign Out
              </button>
            </div>

            <div className="arcade-strip">
              <div className="tile">
                <small>Street Cred</small>
                <b>LVL {cred.level}</b>
                <span className="muted mono">{(user.xp ?? 0).toLocaleString()} XP</span>
              </div>
              <div className="tile">
                <small>Eddies</small>
                <b>€$ {(user.eddies ?? 0).toLocaleString()}</b>
                <span className="muted mono">Arcade bank</span>
              </div>
              <div className="tile">
                <small>Combined Score</small>
                <b>{combinedScore.toLocaleString()}</b>
                <span className="muted mono">{ARCADE_GAMES.length} cabinets</span>
              </div>
              <div className="tile">
                <small>Total Runs</small>
                <b>{totalPlays.toLocaleString()}</b>
                <span className="muted mono">Synced via SSO</span>
              </div>
            </div>

            <div className="session-privs">
              <h3><Icon name="shield" className="icon-xs" />Assigned Privileges <span className="count">{effectivePrivileges.length}</span></h3>
              {user.role === 'recruiter_guest' && (
                <p className="sandbox-note">
                  <Icon name="alert" className="icon-xs" />
                  Sandbox mode active: all created VMs, containers, and routes are tagged and audited. CT 102 is permanently protected.
                </p>
              )}
              <div className="priv-grid">
                {effectivePrivileges.map((key) => {
                  const info = PRIVILEGE_META[key];
                  return (
                    <div key={key} className="priv-item">
                      <strong>{info?.label ?? key}</strong>
                      <span>{info?.desc ?? key}</span>
                    </div>
                  );
                })}
                {effectivePrivileges.length === 0 && <p className="muted">No privileges assigned to this account.</p>}
              </div>
            </div>
          </section>

          {!user.isLegacy ? (
            <section className="panel">
              <div className="panel-head">
                <h2><Icon name="key" />Change Password</h2>
              </div>
              <form className="form" onSubmit={submitChangePassword}>
                <label>
                  Current password
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </label>
                <label>
                  New password
                  <input
                    type="password"
                    required
                    minLength={user.role === 'player' ? 4 : 6}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={user.role === 'player' ? '4–8 digit PIN' : '6+ characters'}
                  />
                </label>
                <label>
                  Confirm new password
                  <input
                    type="password"
                    required
                    minLength={user.role === 'player' ? 4 : 6}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </label>
                <button className="primary" type="submit" disabled={pwState === 'busy'}>
                  <Icon name="key" />{pwState === 'busy' ? 'Updating…' : 'Update Password'}
                </button>
                {pwMsg && <p className={`message ${pwState === 'ok' ? 'success' : 'error'}`}>{pwMsg}</p>}
              </form>
            </section>
          ) : (
            <section className="panel notice">
              <h2><Icon name="key" />Legacy Session</h2>
              <p className="muted">You unlocked with the legacy main password. Sign in with an SSO account to manage passwords or sync Arcade scores.</p>
            </section>
          )}
        </div>
      ) : isLegacyOnly ? (
        <div className="login-layout">
          <section className="panel session-card">
            <div className="panel-head">
              <h2><Icon name="unlock" />Legacy Session Active</h2>
              <span className="role-badge owner">LEGACY OWNER</span>
            </div>
            <p className="muted">Dashboard controls are unlocked in this browser tab using the legacy main password.</p>
            <div className="quick-links">
              <a className="btn solid" href="#/"><Icon name="grid" />Overview</a>
              <a className="btn" href="#/users"><Icon name="users" />Users &amp; Audit</a>
              <a className="btn" href="/game/"><Icon name="gamepad" />Cyberpunk Game Hub</a>
              <button type="button" className="ghost" onClick={() => void handleSignOut()}>
                <Icon name="logout" className="icon-xs" />Lock Session
              </button>
            </div>
          </section>
          <Login
            onLogin={onLogin}
            needsBootstrap={needsBootstrap}
            allowLegacyPassword={allowLegacyPassword}
          />
        </div>
      ) : (
        <div className="login-layout">
          <Login
            onLogin={onLogin}
            needsBootstrap={needsBootstrap}
            allowLegacyPassword={allowLegacyPassword}
          />
          <aside className="panel login-aside">
            <p className="eyebrow"><Icon name="spark" className="icon-xs" />Night Lab // SSO</p>
            <h2>One identity everywhere</h2>
            <p className="muted">
              Your session cookie secures both the Proxmox infrastructure dashboard and the Night Lab Arcade 2077 cabinets.
            </p>
            <ul className="aside-list">
              <li>
                <span className="role-badge owner">OWNER</span>
                <span>Full server, provisioning, settings, and RBAC control.</span>
              </li>
              <li>
                <span className="role-badge admin">ADMIN</span>
                <span>Granular operator access across containers, sites, logs, and agents.</span>
              </li>
              <li>
                <span className="role-badge guest">RECRUITER GUEST</span>
                <span>Time-limited sandbox credentials with full audit trail (CT 102 protected).</span>
              </li>
              <li>
                <span className="role-badge player">PLAYER</span>
                <span>Arcade 2077 cloud profile, Street Cred XP, Eddies, and leaderboards.</span>
              </li>
            </ul>
            <a className="btn" href="/game/"><Icon name="gamepad" />Launch Cyberpunk Game Hub</a>
          </aside>
        </div>
      )}
    </div>
  );
}
