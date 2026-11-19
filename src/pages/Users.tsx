import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ARCADE_GAMES,
  AVATAR_GLYPH,
  Icon,
  PRIVILEGE_KEYS,
  PRIVILEGE_META,
  ROLE_META,
  apiJson,
  copyText,
  formatAgo,
  formatCountdown,
  formatDateTime,
  hasPriv,
  matches,
  streetCredLevel,
} from '../lib';
import type { AdminUser, AuditEntry, AuthRole, AuthUser } from '../lib';

type UsersApiResponse = {
  users: AdminUser[];
  privileges: string[];
  presets: Record<string, string[]>;
  settings: { allowLegacyPassword: boolean };
};

type AuditApiResponse = {
  logs: AuditEntry[];
  sandboxSummary?: {
    count?: number;
    totalEvents?: number;
    recent?: AuditEntry[];
  };
};

type CreatedCredential = {
  title: string;
  username: string;
  displayName: string;
  role: AuthRole;
  password: string;
  expiresAt: string | null;
  note?: string;
  kickedSessions?: boolean;
};

type RoleFilter = 'all' | 'staff' | 'recruiter_guest' | 'player';
type ActionCategory = '' | 'auth' | 'users' | 'compute' | 'sites' | 'ops';

const DURATION_OPTIONS = [
  { hours: 2, label: '2h' },
  { hours: 8, label: '8h' },
  { hours: 24, label: '24h' },
  { hours: 72, label: '72h' },
  { hours: 168, label: '7d' },
] as const;

const DEFAULT_GUEST_PRIVS = PRIVILEGE_KEYS.filter(
  (k) => k !== 'manage_users' && k !== 'run_updates' && k !== 'manage_settings',
);
const DEFAULT_ADMIN_PRIVS = PRIVILEGE_KEYS.filter((k) => k !== 'manage_users');
const DEFAULT_PLAYER_PRIVS = ['play_games'];

function userGameStats(u: AdminUser) {
  const xp = Number(u.xp ?? 0) || 0;
  const eddies = Number(u.eddies ?? 0) || 0;
  const scores = (u.scores && typeof u.scores === 'object' ? u.scores : u.profile?.scores) ?? {};
  const playsMap =
    u.plays && typeof u.plays === 'object'
      ? u.plays
      : u.profile?.plays && typeof u.profile.plays === 'object'
        ? u.profile.plays
        : {};
  const totalPlays =
    typeof u.totalPlays === 'number'
      ? u.totalPlays
      : typeof u.plays === 'number'
        ? u.plays
        : Object.values(playsMap).reduce((s, n) => s + (Number(n) || 0), 0);
  const combinedScore =
    typeof u.combinedScore === 'number'
      ? u.combinedScore
      : Object.values(scores).reduce((s, n) => s + (Number(n) || 0), 0);
  return {
    xp,
    eddies,
    scores,
    playsMap,
    totalPlays,
    combinedScore,
    activeSessions: Number(u.activeSessions ?? 0) || 0,
  };
}

function auditActor(entry: AuditEntry): { username: string; role: string } {
  return {
    username: entry.actorUsername || entry.actor?.username || 'anonymous',
    role: entry.actorRole || entry.actor?.role || '',
  };
}

function auditSandboxLabel(entry: AuditEntry): string {
  if (typeof entry.sandboxTag === 'string' && entry.sandboxTag) return entry.sandboxTag;
  return entry.sandboxTag ? 'SANDBOX' : '';
}

function matchesActionCategory(action: string, cat: ActionCategory): boolean {
  if (!cat) return true;
  if (cat === 'auth') return /(auth|login|logout|bootstrap|password|session)/i.test(action);
  if (cat === 'users') return /(user|guest|priv|role|revoke)/i.test(action);
  if (cat === 'compute') return /(vm|lxc|proxmox|provision|container|power|guest\.(provision|delete_vm|power))/i.test(action);
  if (cat === 'sites') return /(site|app|route|caddy|wordpress|aisite|ai\.)/i.test(action);
  if (cat === 'ops') return /(update|setting|config|note|agent|hub)/i.test(action);
  return true;
}

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'ok' || s === 'success' || s === 'allowed') return 'ok';
  if (s === 'denied' || s === 'forbidden' || s === 'blocked' || s === 'warn') return 'denied';
  return 'error';
}

function formatInviteText(cred: CreatedCredential): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const dashUrl = `${origin}/#/login`;
  const arcadeUrl = `${origin}/game/`;
  const exp = cred.expiresAt ? formatDateTime(cred.expiresAt) : 'No expiration';
  return [
    `Homelab Dashboard & Cyber Arcade Access`,
    `Dashboard: ${dashUrl}`,
    `Arcade: ${arcadeUrl}`,
    `Username: ${cred.username}`,
    `Password: ${cred.password}`,
    `Role: ${ROLE_META[cred.role]?.label ?? cred.role}`,
    `Expires: ${exp}`,
    cred.note ? `Note: ${cred.note}` : '',
    cred.role === 'recruiter_guest' ? 'Sandbox mode: CT 102 is protected and off-limits.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export default function Users({
  currentUser,
  pass,
  onRefreshAuth,
}: {
  currentUser: AuthUser | null;
  pass: string;
  onRefreshAuth: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<'accounts' | 'audit'>('accounts');
  const [usersData, setUsersData] = useState<UsersApiResponse | null>(null);
  const [auditData, setAuditData] = useState<AuditApiResponse | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // Filters (Accounts)
  const [userSearch, setUserSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');

  // Create Drawers
  const [drawer, setDrawer] = useState<'none' | 'guest' | 'user'>('none');
  const [createdCred, setCreatedCred] = useState<CreatedCredential | null>(null);
  const [copiedId, setCopiedId] = useState('');

  // Recruiter Guest Form
  const [gUsername, setGUsername] = useState('recruiter-');
  const [gDisplay, setGDisplay] = useState('');
  const [gNote, setGNote] = useState('Recruiter — ');
  const [gHours, setGHours] = useState(24);
  const [gAutoPass, setGAutoPass] = useState(true);
  const [gPassword, setGPassword] = useState('');
  const [gPrivs, setGPrivs] = useState<string[]>([...DEFAULT_GUEST_PRIVS]);
  const [creatingGuest, setCreatingGuest] = useState(false);

  // New User / Admin Form
  const [uUsername, setUUsername] = useState('');
  const [uDisplay, setUDisplay] = useState('');
  const [uRole, setURole] = useState<AuthRole>('admin');
  const [uNote, setUNote] = useState('');
  const [uAutoPass, setUAutoPass] = useState(false);
  const [uPassword, setUPassword] = useState('');
  const [uPrivs, setUPrivs] = useState<string[]>([...DEFAULT_ADMIN_PRIVS]);
  const [creatingUser, setCreatingUser] = useState(false);

  // Inline Editors per User
  const [editingPrivUserId, setEditingPrivUserId] = useState<string | null>(null);
  const [privDraft, setPrivDraft] = useState<string[]>([]);
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [resetAutoPass, setResetAutoPass] = useState(true);
  const [resetCustomPass, setResetCustomPass] = useState('');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Audit Filters
  const [auditQuery, setAuditQuery] = useState('');
  const [auditRole, setAuditRole] = useState('');
  const [auditCategory, setAuditCategory] = useState<ActionCategory>('');
  const [auditSandboxOnly, setAuditSandboxOnly] = useState(false);

  const isLegacyOwner = Boolean(pass && pass !== '__sso__' && !currentUser);
  const isOwner = currentUser?.role === 'owner' || isLegacyOwner;
  const canManage = isLegacyOwner || hasPriv(currentUser, 'manage_users');

  const presetFor = useCallback(
    (role: AuthRole): string[] => {
      const fromServer = usersData?.presets?.[role];
      if (Array.isArray(fromServer) && fromServer.length > 0) return [...fromServer];
      if (role === 'owner') return [...PRIVILEGE_KEYS];
      if (role === 'recruiter_guest') return [...DEFAULT_GUEST_PRIVS];
      if (role === 'admin') return [...DEFAULT_ADMIN_PRIVS];
      return [...DEFAULT_PLAYER_PRIVS];
    },
    [usersData?.presets],
  );

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const data = await apiJson<UsersApiResponse>('./api/admin/users', {}, pass);
      setUsersData(data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load users.');
    } finally {
      setLoadingUsers(false);
    }
  }, [pass]);

  const loadAudit = useCallback(async () => {
    setLoadingAudit(true);
    try {
      const params = new URLSearchParams();
      params.set('action', '');
      params.set('actor', '');
      params.set('role', auditRole);
      params.set('sandboxOnly', auditSandboxOnly ? '1' : '');
      params.set('q', auditQuery.trim());
      params.set('limit', '150');
      const data = await apiJson<AuditApiResponse>(`./api/admin/audit?${params.toString()}`, {}, pass);
      setAuditData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load audit log.');
    } finally {
      setLoadingAudit(false);
    }
  }, [pass, auditRole, auditSandboxOnly, auditQuery]);

  useEffect(() => {
    if (!canManage) return;
    void loadUsers();
    void loadAudit();
  }, [canManage]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const hasExpiring = usersData?.users.some((u) => Boolean(u.expiresAt));
    if (!hasExpiring) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [usersData?.users]);

  useEffect(() => {
    if (tab === 'audit' && canManage) {
      void loadAudit();
    }
  }, [tab, auditRole, auditSandboxOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const openGuestDrawer = () => {
    setDrawer((cur) => (cur === 'guest' ? 'none' : 'guest'));
    setGPrivs(presetFor('recruiter_guest'));
    setGAutoPass(true);
    setGPassword('');
    setGHours(24);
    setError('');
  };

  const openUserDrawer = () => {
    setDrawer((cur) => (cur === 'user' ? 'none' : 'user'));
    setURole('admin');
    setUPrivs(presetFor('admin'));
    setUAutoPass(false);
    setUPassword('');
    setError('');
  };

  const toggleInList = (list: string[], key: string): string[] =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

  const handleCopy = async (id: string, text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? '' : cur)), 2400);
    }
  };

  const submitGuest = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setCreatingGuest(true);
    try {
      const payload = {
        username: gUsername.trim(),
        displayName: gDisplay.trim() || gUsername.trim(),
        role: 'recruiter_guest' as const,
        durationHours: gHours,
        privileges: gPrivs,
        note: gNote.trim(),
        generatePassword: gAutoPass,
        ...(gAutoPass ? {} : { password: gPassword }),
      };
      const res = await apiJson<{ ok: boolean; user: AdminUser; generatedPassword?: string }>(
        './api/admin/users',
        { method: 'POST', body: JSON.stringify(payload) },
        pass,
      );
      const pw = res.generatedPassword || gPassword;
      setCreatedCred({
        title: 'Recruiter Guest Credentials Created',
        username: res.user.username,
        displayName: res.user.displayName,
        role: res.user.role,
        password: pw,
        expiresAt: res.user.expiresAt,
        note: res.user.note,
      });
      setDrawer('none');
      setGUsername('recruiter-');
      setGDisplay('');
      setGNote('Recruiter — ');
      setGPassword('');
      setNotice(`Created Recruiter Guest @${res.user.username}.`);
      await loadUsers();
      await loadAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create recruiter guest.');
    } finally {
      setCreatingGuest(false);
    }
  };

  const submitUser = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setCreatingUser(true);
    try {
      const payload = {
        username: uUsername.trim(),
        displayName: uDisplay.trim() || uUsername.trim(),
        role: uRole,
        privileges: uRole === 'owner' ? [...PRIVILEGE_KEYS] : uPrivs,
        note: uNote.trim(),
        generatePassword: uAutoPass,
        ...(uAutoPass ? {} : { password: uPassword }),
      };
      const res = await apiJson<{ ok: boolean; user: AdminUser; generatedPassword?: string }>(
        './api/admin/users',
        { method: 'POST', body: JSON.stringify(payload) },
        pass,
      );
      const pw = res.generatedPassword || uPassword;
      if (pw) {
        setCreatedCred({
          title: `Account Created (${ROLE_META[res.user.role].label})`,
          username: res.user.username,
          displayName: res.user.displayName,
          role: res.user.role,
          password: pw,
          expiresAt: res.user.expiresAt,
          note: res.user.note,
        });
      }
      setDrawer('none');
      setUUsername('');
      setUDisplay('');
      setUNote('');
      setUPassword('');
      setNotice(`Created user @${res.user.username}.`);
      await loadUsers();
      await loadAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create user.');
    } finally {
      setCreatingUser(false);
    }
  };

  const savePrivileges = async (u: AdminUser) => {
    setBusyUserId(u.id);
    setError('');
    try {
      await apiJson<{ ok: boolean; user: AdminUser }>(
        `./api/admin/users/${encodeURIComponent(u.id)}`,
        { method: 'PATCH', body: JSON.stringify({ privileges: privDraft }) },
        pass,
      );
      setEditingPrivUserId(null);
      setNotice(`Updated privileges for @${u.username}.`);
      await loadUsers();
      await onRefreshAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update privileges.');
    } finally {
      setBusyUserId(null);
    }
  };

  const extendGuest = async (u: AdminUser, hours: number) => {
    setBusyUserId(u.id);
    setError('');
    try {
      await apiJson<{ ok: boolean; user: AdminUser }>(
        `./api/admin/users/${encodeURIComponent(u.id)}`,
        { method: 'PATCH', body: JSON.stringify({ extendHours: hours, disabled: false }) },
        pass,
      );
      setNotice(`Extended @${u.username} by +${hours}h.`);
      await loadUsers();
      await loadAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extend guest.');
    } finally {
      setBusyUserId(null);
    }
  };

  const revokeGuest = async (u: AdminUser) => {
    if (!window.confirm(`Revoke Recruiter Guest @${u.username} immediately and kick active sessions?`)) return;
    setBusyUserId(u.id);
    setError('');
    try {
      await apiJson<{ ok: boolean }>(
        `./api/admin/users/${encodeURIComponent(u.id)}`,
        { method: 'PATCH', body: JSON.stringify({ expiresAt: new Date().toISOString(), disabled: true }) },
        pass,
      );
      await apiJson<{ ok: boolean }>(
        `./api/admin/users/${encodeURIComponent(u.id)}/revoke-sessions`,
        { method: 'POST', body: JSON.stringify({}) },
        pass,
      );
      setNotice(`Revoked @${u.username} and kicked all active sessions.`);
      await loadUsers();
      await loadAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke guest.');
    } finally {
      setBusyUserId(null);
    }
  };

  const submitResetPassword = async (e: FormEvent<HTMLFormElement>, u: AdminUser) => {
    e.preventDefault();
    setBusyUserId(u.id);
    setError('');
    try {
      const res = await apiJson<{ ok: boolean; newPassword: string }>(
        `./api/admin/users/${encodeURIComponent(u.id)}/reset-password`,
        {
          method: 'POST',
          body: JSON.stringify({
            generatePassword: resetAutoPass,
            ...(resetAutoPass ? {} : { password: resetCustomPass }),
          }),
        },
        pass,
      );
      setCreatedCred({
        title: 'Password Reset · Active Sessions Kicked',
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        password: res.newPassword,
        expiresAt: u.expiresAt,
        note: u.note,
        kickedSessions: true,
      });
      setResetUserId(null);
      setResetCustomPass('');
      setNotice(`Reset password for @${u.username} and revoked active sessions.`);
      await loadUsers();
      await loadAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed.');
    } finally {
      setBusyUserId(null);
    }
  };

  const kickSessions = async (u: AdminUser) => {
    setBusyUserId(u.id);
    setError('');
    try {
      await apiJson<{ ok: boolean }>(
        `./api/admin/users/${encodeURIComponent(u.id)}/revoke-sessions`,
        { method: 'POST', body: JSON.stringify({}) },
        pass,
      );
      setNotice(`Revoked all active sessions for @${u.username}.`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to kick sessions.');
    } finally {
      setBusyUserId(null);
    }
  };

  const toggleDisabled = async (u: AdminUser) => {
    setBusyUserId(u.id);
    setError('');
    try {
      await apiJson<{ ok: boolean; user: AdminUser }>(
        `./api/admin/users/${encodeURIComponent(u.id)}`,
        { method: 'PATCH', body: JSON.stringify({ disabled: !u.disabled }) },
        pass,
      );
      setNotice(`${u.disabled ? 'Enabled' : 'Disabled'} @${u.username}.`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update user status.');
    } finally {
      setBusyUserId(null);
    }
  };

  const deleteUser = async (u: AdminUser) => {
    if (!window.confirm(`Delete account @${u.username}? This permanently removes their access and Arcade scores.`)) return;
    setBusyUserId(u.id);
    setError('');
    try {
      await apiJson<{ ok: boolean }>(
        `./api/admin/users/${encodeURIComponent(u.id)}`,
        { method: 'DELETE' },
        pass,
      );
      setNotice(`Deleted @${u.username}.`);
      await loadUsers();
      await loadAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete user.');
    } finally {
      setBusyUserId(null);
    }
  };

  const toggleLegacySetting = async () => {
    if (!usersData) return;
    setSavingSettings(true);
    setError('');
    try {
      const next = !usersData.settings.allowLegacyPassword;
      const res = await apiJson<{ ok: boolean; settings: { allowLegacyPassword: boolean } }>(
        './api/admin/settings',
        { method: 'PUT', body: JSON.stringify({ allowLegacyPassword: next }) },
        pass,
      );
      setUsersData((prev) => (prev ? { ...prev, settings: res.settings } : prev));
      setNotice(`Legacy main-password fallback ${res.settings.allowLegacyPassword ? 'enabled' : 'disabled'}.`);
      await onRefreshAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save security setting.');
    } finally {
      setSavingSettings(false);
    }
  };

  const users = usersData?.users ?? [];
  const q = userSearch.trim().toLowerCase();

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      if (roleFilter === 'staff' && u.role !== 'owner' && u.role !== 'admin') return false;
      if (roleFilter === 'recruiter_guest' && u.role !== 'recruiter_guest') return false;
      if (roleFilter === 'player' && u.role !== 'player') return false;
      return matches(q, u.username, u.displayName, u.role, u.note ?? '');
    });
  }, [users, roleFilter, q]);

  const sandboxSummary = useMemo(() => {
    const logs = auditData?.logs ?? [];
    const recent = auditData?.sandboxSummary?.recent ?? logs.filter((l) => Boolean(l.sandboxTag)).slice(0, 12);
    const count = auditData?.sandboxSummary?.count ?? auditData?.sandboxSummary?.totalEvents ?? recent.length;
    return { count, recent };
  }, [auditData]);

  const kpis = useMemo(() => {
    const total = users.length;
    const active = users.filter((u) => !u.disabled).length;
    const sessions = users.reduce((s, u) => s + userGameStats(u).activeSessions, 0);
    const guests = users.filter((u) => u.role === 'recruiter_guest');
    const activeGuests = guests.filter((g) => !g.disabled && (!g.expiresAt || !formatCountdown(g.expiresAt, now).expired));
    const totalRuns = users.reduce((s, u) => s + userGameStats(u).totalPlays, 0);
    return {
      total,
      active,
      sessions,
      guestCount: guests.length,
      activeGuestCount: activeGuests.length,
      sandboxCount: sandboxSummary.count,
      totalRuns,
    };
  }, [users, now, sandboxSummary.count]);

  const filteredLogs = useMemo(() => {
    const rows = auditData?.logs ?? [];
    const lq = auditQuery.trim().toLowerCase();
    return rows.filter((row) => {
      const actor = auditActor(row);
      const sbLabel = auditSandboxLabel(row);
      if (!matchesActionCategory(row.action, auditCategory)) return false;
      if (auditSandboxOnly && !row.sandboxTag && actor.role !== 'recruiter_guest') return false;
      if (auditRole && actor.role !== auditRole) return false;
      if (!lq) return true;
      return matches(lq, actor.username, actor.role, row.action, row.target, row.ip, sbLabel);
    });
  }, [auditData?.logs, auditCategory, auditSandboxOnly, auditRole, auditQuery]);

  if (!canManage) {
    return (
      <>
        <header className="page-head">
          <div>
            <p className="eyebrow"><Icon name="shield" className="icon-xs" />Access Denied</p>
            <h1>Insufficient Privilege</h1>
            <p className="lede">Your account does not hold the <code>manage_users</code> privilege required for Users &amp; Audit.</p>
          </div>
        </header>
        <section className="panel notice">
          <h2>Restricted Area</h2>
          <p className="muted">Ask an Owner to grant <code>manage_users</code> if you need to administer accounts or inspect audit logs.</p>
          <p className="hint"><a className="link" href="#/">Return to Overview →</a></p>
        </section>
      </>
    );
  }

  return (
    <div className="users-page">
      <header className="page-head">
        <div>
          <p className="eyebrow"><Icon name="shield" className="icon-xs" />RBAC · Single Sign-On</p>
          <h1><Icon name="users" />Users &amp; Audit</h1>
          <p className="lede">Manage SSO accounts, time-limited Recruiter Guest sandboxes, Cyber Arcade progression, and audit logs.</p>
        </div>
        <div className="users-subtabs" role="tablist" aria-label="Users console sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'accounts'}
            className={`toggle ${tab === 'accounts' ? 'on' : ''}`}
            onClick={() => setTab('accounts')}
          >
            <Icon name="users" className="icon-xs" />
            Accounts &amp; Scores
            <span className="count">{users.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'audit'}
            className={`toggle ${tab === 'audit' ? 'on' : ''}`}
            onClick={() => setTab('audit')}
          >
            <Icon name="activity" className="icon-xs" />
            Audit Log &amp; Sandbox
            {kpis.sandboxCount > 0 && <span className="count">{kpis.sandboxCount}</span>}
          </button>
        </div>
      </header>

      {/* 3 Top KPI Tiles */}
      <section className="user-kpis" aria-label="Account summary">
        <div className="stat">
          <small><Icon name="users" className="icon-xs" />Accounts &amp; Sessions</small>
          <b>{kpis.active} / {kpis.total}</b>
          <span className="muted">{kpis.sessions} active session{kpis.sessions === 1 ? '' : 's'} across SSO</span>
        </div>
        <div className="stat">
          <small><Icon name="clock" className="icon-xs" />Recruiter Guests</small>
          <b>{kpis.activeGuestCount} live</b>
          <span className="muted">{kpis.guestCount} total guest account{kpis.guestCount === 1 ? '' : 's'}</span>
        </div>
        <div className="stat">
          <small><Icon name="activity" className="icon-xs" />Sandbox &amp; Arcade</small>
          <b>{kpis.sandboxCount} tagged</b>
          <span className="muted">{kpis.totalRuns.toLocaleString()} total Arcade runs</span>
        </div>
      </section>

      {error && <p className="message error">{error}</p>}
      {notice && <p className="message success">{notice}</p>}

      {createdCred && (
        <section className="panel creds-box" aria-live="polite">
          <div className="panel-head">
            <h2><Icon name="key" />{createdCred.title}</h2>
            <div className="tools">
              <button
                type="button"
                className="primary"
                onClick={() => void handleCopy('invite', formatInviteText(createdCred))}
              >
                <Icon name="copy" className="icon-xs" />
                {copiedId === 'invite' ? 'Invite Copied!' : 'Copy Invite'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void handleCopy('pw', createdCred.password)}
              >
                <Icon name="copy" className="icon-xs" />
                {copiedId === 'pw' ? 'Copied!' : 'Copy Password'}
              </button>
              <button type="button" className="x" aria-label="Dismiss credentials" onClick={() => setCreatedCred(null)}>×</button>
            </div>
          </div>
          <div className="creds-grid">
            <div className="tile">
              <small>Username</small>
              <b className="mono">{createdCred.username}</b>
            </div>
            <div className="tile">
              <small>Password</small>
              <b className="mono">{createdCred.password}</b>
            </div>
            <div className="tile">
              <small>Expires</small>
              <b>{createdCred.expiresAt ? formatDateTime(createdCred.expiresAt) : 'Never'}</b>
            </div>
            <div className="tile">
              <small>Role</small>
              <b>{ROLE_META[createdCred.role]?.label ?? createdCred.role}</b>
            </div>
          </div>
          <p className="hint muted">
            Save or copy these credentials now — plaintext passwords are only shown once.
            {createdCred.kickedSessions ? ' All prior sessions for this account were revoked.' : ''}
          </p>
        </section>
      )}

      {tab === 'accounts' ? (
        <>
          {/* Toolbar */}
          <section className="panel users-toolbar-panel">
            <div className="users-toolbar">
              <label className="users-search">
                <Icon name="search" className="icon-xs" />
                <input
                  type="search"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Filter by username, name, note…"
                  aria-label="Filter accounts"
                />
              </label>
              <div className="tools" role="group" aria-label="Role filter">
                {([
                  ['all', 'All'],
                  ['staff', 'Owner / Admin'],
                  ['recruiter_guest', 'Recruiter Guests'],
                  ['player', 'Players'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`toggle ${roleFilter === key ? 'on' : ''}`}
                    onClick={() => setRoleFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="users-cta-group">
                <button type="button" className="btn solid" onClick={openGuestDrawer}>
                  <Icon name="clock" className="icon-xs" />+ Recruiter Guest
                </button>
                <button type="button" className="btn" onClick={openUserDrawer}>
                  <Icon name="plus" className="icon-xs" />+ New User / Admin
                </button>
              </div>
            </div>
          </section>

          {/* Create Recruiter Guest Drawer */}
          {drawer === 'guest' && (
            <form className="panel drawer-panel" onSubmit={submitGuest}>
              <div className="panel-head">
                <h2><Icon name="clock" />Create Recruiter Guest Sandbox</h2>
                <button type="button" className="x" aria-label="Close form" onClick={() => setDrawer('none')}>×</button>
              </div>
              <p className="sandbox-note">
                <Icon name="alert" className="icon-xs" />
                CT 102 (Jacob&apos;s app) is permanently off-limits in sandbox mode regardless of checked privileges. All actions are logged and tagged.
              </p>
              <div className="drawer-grid">
                <label>
                  Username
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={24}
                    pattern="[A-Za-z0-9_.\- ]+"
                    value={gUsername}
                    onChange={(e) => setGUsername(e.target.value)}
                    placeholder="recruiter-acme"
                  />
                </label>
                <label>
                  Display Name
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={48}
                    value={gDisplay}
                    onChange={(e) => setGDisplay(e.target.value)}
                    placeholder="Acme Corp Recruiter"
                  />
                </label>
                <label>
                  Note / Company
                  <input
                    type="text"
                    maxLength={120}
                    value={gNote}
                    onChange={(e) => setGNote(e.target.value)}
                    placeholder="Recruiter — Acme Corp"
                  />
                </label>
              </div>

              <div className="duration-row">
                <span className="field-label">Access Duration</span>
                <div className="tools">
                  {DURATION_OPTIONS.map((opt) => (
                    <button
                      key={opt.hours}
                      type="button"
                      className={`toggle ${gHours === opt.hours ? 'on' : ''}`}
                      onClick={() => setGHours(opt.hours)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="priv-picker">
                <span className="field-label">Sandbox Privileges (Full Sandbox preset)</span>
                <div className="priv-check-grid">
                  {PRIVILEGE_KEYS.map((key) => {
                    const info = PRIVILEGE_META[key];
                    const checked = gPrivs.includes(key);
                    const ownerLocked = key === 'manage_users' && !isOwner;
                    return (
                      <label key={key} className={`priv-check ${checked ? 'on' : ''}`} title={ownerLocked ? 'Owner only' : undefined}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={ownerLocked}
                          onChange={() => setGPrivs((cur) => toggleInList(cur, key))}
                        />
                        <span>
                          <strong>{info.label}</strong>
                          <small>{info.desc}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="drawer-foot">
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={gAutoPass}
                    onChange={(e) => setGAutoPass(e.target.checked)}
                  />
                  Auto-generate strong password
                </label>
                {!gAutoPass && (
                  <label className="inline-pass">
                    Custom Password
                    <input
                      type="password"
                      required={!gAutoPass}
                      minLength={6}
                      autoComplete="new-password"
                      value={gPassword}
                      onChange={(e) => setGPassword(e.target.value)}
                      placeholder="6+ characters"
                    />
                  </label>
                )}
                <button type="submit" className="primary" disabled={creatingGuest}>
                  <Icon name="clock" className="icon-xs" />
                  {creatingGuest ? 'Creating Guest…' : `Create Guest (${DURATION_OPTIONS.find((d) => d.hours === gHours)?.label ?? `${gHours}h`})`}
                </button>
              </div>
            </form>
          )}

          {/* Create New User / Admin Drawer */}
          {drawer === 'user' && (
            <form className="panel drawer-panel" onSubmit={submitUser}>
              <div className="panel-head">
                <h2><Icon name="plus" />Create User / Admin Account</h2>
                <button type="button" className="x" aria-label="Close form" onClick={() => setDrawer('none')}>×</button>
              </div>
              <div className="drawer-grid">
                <label>
                  Username
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={24}
                    pattern="[A-Za-z0-9_.\- ]+"
                    value={uUsername}
                    onChange={(e) => setUUsername(e.target.value)}
                    placeholder="operator-alex"
                  />
                </label>
                <label>
                  Display Name
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={48}
                    value={uDisplay}
                    onChange={(e) => setUDisplay(e.target.value)}
                    placeholder="Alex"
                  />
                </label>
                <label>
                  Role
                  <select
                    value={uRole}
                    onChange={(e) => {
                      const nextRole = e.target.value as AuthRole;
                      setURole(nextRole);
                      setUPrivs(presetFor(nextRole));
                    }}
                  >
                    <option value="admin">Admin</option>
                    <option value="player">Player (Arcade)</option>
                    {isOwner && <option value="owner">Owner</option>}
                  </select>
                </label>
                <label>
                  Note (optional)
                  <input
                    type="text"
                    maxLength={120}
                    value={uNote}
                    onChange={(e) => setUNote(e.target.value)}
                    placeholder="Team member / Arcade player"
                  />
                </label>
              </div>

              {uRole !== 'owner' ? (
                <div className="priv-picker">
                  <span className="field-label">Assigned Privileges</span>
                  <div className="priv-check-grid">
                    {PRIVILEGE_KEYS.map((key) => {
                      const info = PRIVILEGE_META[key];
                      const checked = uPrivs.includes(key);
                      const ownerLocked = key === 'manage_users' && !isOwner;
                      return (
                        <label key={key} className={`priv-check ${checked ? 'on' : ''}`} title={ownerLocked ? 'Owner only' : undefined}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={ownerLocked}
                            onChange={() => setUPrivs((cur) => toggleInList(cur, key))}
                          />
                          <span>
                            <strong>{info.label}</strong>
                            <small>{info.desc}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="sandbox-note">Owners hold all 11 privileges unconditionally.</p>
              )}

              <div className="drawer-foot">
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={uAutoPass}
                    onChange={(e) => setUAutoPass(e.target.checked)}
                  />
                  Auto-generate password
                </label>
                {!uAutoPass && (
                  <label className="inline-pass">
                    {uRole === 'player' ? '4–8 digit PIN' : 'Password (6+ chars)'}
                    <input
                      type="password"
                      required={!uAutoPass}
                      minLength={uRole === 'player' ? 4 : 6}
                      maxLength={uRole === 'player' ? 8 : 128}
                      pattern={uRole === 'player' ? '\\d{4,8}' : undefined}
                      autoComplete="new-password"
                      value={uPassword}
                      onChange={(e) => setUPassword(e.target.value)}
                      placeholder={uRole === 'player' ? '4–8 digits' : '6+ characters'}
                    />
                  </label>
                )}
                <button type="submit" className="primary" disabled={creatingUser}>
                  <Icon name="plus" className="icon-xs" />
                  {creatingUser ? 'Creating…' : 'Create Account'}
                </button>
              </div>
            </form>
          )}

          {/* Accounts List */}
          <section className="users-list">
            {loadingUsers && !usersData && <p className="panel muted">Loading accounts…</p>}
            {!loadingUsers && filteredUsers.length === 0 && (
              <div className="panel notice">
                <h2>No matching accounts</h2>
                <p className="muted">Try clearing your search or role filter.</p>
              </div>
            )}
            {filteredUsers.map((u) => {
              const roleMeta = ROLE_META[u.role];
              const expiry = u.expiresAt ? formatCountdown(u.expiresAt, now) : null;
              const stats = userGameStats(u);
              const cred = streetCredLevel(stats.xp);
              const isSelf = currentUser?.id === u.id;
              const isProtectedOwner = u.role === 'owner';
              const busy = busyUserId === u.id;
              const editingPrivs = editingPrivUserId === u.id;
              const resettingPw = resetUserId === u.id;

              return (
                <article key={u.id} className={`panel user-card ${u.disabled || expiry?.expired ? 'is-muted' : ''}`}>
                  <div className="user-head">
                    <div className="user-identity">
                      <span className={`user-avatar role-${roleMeta.cls}`} aria-hidden="true">
                        {AVATAR_GLYPH[u.avatar] ?? '◈'}
                      </span>
                      <div>
                        <div className="user-title-row">
                          <h3>{u.displayName}</h3>
                          <span className="mono dim">@{u.username}</span>
                          <span className={`role-badge ${roleMeta.cls}`}>{roleMeta.label}</span>
                          {isSelf && <span className="pill new">You</span>}
                          {u.disabled && <span className="role-badge expired">DISABLED</span>}
                          {expiry && (
                            <span className={`countdown-pill ${expiry.expired ? 'expired' : expiry.urgent ? 'urgent' : ''}`}>
                              <Icon name="clock" className="icon-xs" />
                              {expiry.text}
                            </span>
                          )}
                        </div>
                        <p className="user-meta">
                          {u.note ? <span className="user-note">{u.note} · </span> : null}
                          Last login: <strong>{formatAgo(u.lastLoginAt)}</strong>
                          {' · '}
                          <span className="mono">{stats.activeSessions} active session{stats.activeSessions === 1 ? '' : 's'}</span>
                          {u.createdAt ? ` · Created ${formatDateTime(u.createdAt)}` : ''}
                        </p>
                      </div>
                    </div>

                    <div className="user-actions">
                      {!isProtectedOwner && (
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => {
                            if (editingPrivs) setEditingPrivUserId(null);
                            else {
                              setEditingPrivUserId(u.id);
                              setPrivDraft([...u.privileges]);
                            }
                          }}
                        >
                          <Icon name="shield" className="icon-xs" />
                          {editingPrivs ? 'Close Privileges' : 'Privileges'}
                        </button>
                      )}
                      {u.role === 'recruiter_guest' && (
                        <>
                          <button type="button" className="ghost" disabled={busy} onClick={() => void extendGuest(u, 24)}>
                            +24h
                          </button>
                          <button type="button" className="danger" disabled={busy} onClick={() => void revokeGuest(u)}>
                            Revoke
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => {
                          if (resettingPw) setResetUserId(null);
                          else {
                            setResetUserId(u.id);
                            setResetAutoPass(true);
                            setResetCustomPass('');
                          }
                        }}
                      >
                        <Icon name="key" className="icon-xs" />Reset Password
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy || stats.activeSessions === 0}
                        onClick={() => void kickSessions(u)}
                        title="Revoke all active login sessions"
                      >
                        Kick Sessions
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy || isProtectedOwner || isSelf}
                        onClick={() => void toggleDisabled(u)}
                      >
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy || isProtectedOwner || isSelf}
                        onClick={() => void deleteUser(u)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {/* Game Hub Stats Strip */}
                  <div className="user-arcade-strip">
                    <div className="tile">
                      <small>Street Cred</small>
                      <b>LVL {cred.level} <span className="dim mono">({stats.xp.toLocaleString()} XP)</span></b>
                    </div>
                    <div className="tile">
                      <small>Eddies</small>
                      <b>€$ {stats.eddies.toLocaleString()}</b>
                    </div>
                    <div className="tile">
                      <small>Combined Score</small>
                      <b>{stats.combinedScore.toLocaleString()}</b>
                    </div>
                    <div className="tile">
                      <small>Total Plays</small>
                      <b>{stats.totalPlays.toLocaleString()}</b>
                    </div>
                  </div>

                  <details className="user-games">
                    <summary>
                      <Icon name="gamepad" className="icon-xs" />
                      Per-game high scores across {ARCADE_GAMES.length} Cyber Arcade cabinets
                    </summary>
                    <div className="user-games-grid">
                      {ARCADE_GAMES.map((g) => {
                        const score = Number(stats.scores[g.id] ?? 0);
                        const plays = Number(stats.playsMap[g.id] ?? 0);
                        return (
                          <div key={g.id} className="game-score-tile">
                            <span className="game-name" style={{ borderLeftColor: g.accent }}>{g.title}</span>
                            <strong className="mono">{score.toLocaleString()}</strong>
                            <small className="dim">{plays} play{plays === 1 ? '' : 's'}</small>
                          </div>
                        );
                      })}
                    </div>
                  </details>

                  {/* Privilege Tags */}
                  <div className="chips">
                    {u.role === 'owner' ? (
                      <span className="chip owner-chip">All 11 privileges (Owner override)</span>
                    ) : u.privileges.length > 0 ? (
                      u.privileges.map((p) => (
                        <span key={p} className="chip" title={PRIVILEGE_META[p]?.desc ?? p}>
                          {PRIVILEGE_META[p]?.label ?? p}
                        </span>
                      ))
                    ) : (
                      <span className="muted hint">No privileges granted.</span>
                    )}
                  </div>

                  {/* Inline Privilege Editor */}
                  {editingPrivs && (
                    <div className="inline-editor">
                      <div className="priv-check-grid">
                        {PRIVILEGE_KEYS.map((key) => {
                          const info = PRIVILEGE_META[key];
                          const checked = privDraft.includes(key);
                          const ownerLocked = key === 'manage_users' && !isOwner;
                          return (
                            <label key={key} className={`priv-check ${checked ? 'on' : ''}`} title={ownerLocked ? 'Owner only' : undefined}>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={ownerLocked}
                                onChange={() => setPrivDraft((cur) => toggleInList(cur, key))}
                              />
                              <span>
                                <strong>{info.label}</strong>
                                <small>{info.desc}</small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="inline-editor-actions">
                        <button type="button" className="primary" disabled={busy} onClick={() => void savePrivileges(u)}>
                          {busy ? 'Saving…' : 'Save Privileges'}
                        </button>
                        <button type="button" className="ghost" onClick={() => setEditingPrivUserId(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Inline Reset Password Panel */}
                  {resettingPw && (
                    <form className="inline-editor" onSubmit={(e) => void submitResetPassword(e, u)}>
                      <p className="field-label">Reset password for @{u.username} (automatically revokes active sessions)</p>
                      <div className="drawer-foot">
                        <label className="inline-check">
                          <input
                            type="checkbox"
                            checked={resetAutoPass}
                            onChange={(e) => setResetAutoPass(e.target.checked)}
                          />
                          Auto-generate strong password
                        </label>
                        {!resetAutoPass && (
                          <label className="inline-pass">
                            {u.role === 'player' ? 'New 4–8 digit PIN' : 'New password (6+ chars)'}
                            <input
                              type="password"
                              required={!resetAutoPass}
                              minLength={u.role === 'player' ? 4 : 6}
                              maxLength={u.role === 'player' ? 8 : 128}
                              pattern={u.role === 'player' ? '\\d{4,8}' : undefined}
                              autoComplete="new-password"
                              value={resetCustomPass}
                              onChange={(e) => setResetCustomPass(e.target.value)}
                              placeholder={u.role === 'player' ? '4–8 digits' : '6+ characters'}
                            />
                          </label>
                        )}
                        <button type="submit" className="primary" disabled={busy}>
                          {busy ? 'Resetting…' : 'Confirm Reset & Kick Sessions'}
                        </button>
                        <button type="button" className="ghost" onClick={() => setResetUserId(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </article>
              );
            })}
          </section>

          {/* Owner-only Security Settings */}
          {isOwner && usersData && (
            <section className="panel security-panel">
              <div className="panel-head">
                <h2><Icon name="shield" />Security Settings <span className="role-badge owner">OWNER ONLY</span></h2>
              </div>
              <div className="setting-row">
                <div>
                  <strong>Legacy main-password fallback</strong>
                  <p className="muted">
                    When enabled, <code>POST ./api/login</code> and the <code>x-dashboard-password</code> fallback option remain available on sign-in forms. Turn off once all operators use SSO accounts.
                  </p>
                </div>
                <button
                  type="button"
                  className={`toggle ${usersData.settings.allowLegacyPassword ? 'on' : ''}`}
                  disabled={savingSettings}
                  onClick={() => void toggleLegacySetting()}
                >
                  {savingSettings
                    ? 'Saving…'
                    : usersData.settings.allowLegacyPassword
                      ? 'Enabled (click to disable)'
                      : 'Disabled (click to enable)'}
                </button>
              </div>
            </section>
          )}
        </>
      ) : (
        /* Tab 2: Audit Log & Sandbox */
        <>
          {(sandboxSummary.count > 0 || sandboxSummary.recent.length > 0) && (
            <section className="panel sandbox-callout">
              <div className="panel-head">
                <h2>
                  <Icon name="alert" />
                  Sandbox Resources Created by Recruiter Guests
                  <span className="count">{sandboxSummary.count}</span>
                </h2>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setAuditSandboxOnly((v) => !v)}
                >
                  {auditSandboxOnly ? 'Show All Audit Events' : 'Filter Table to Sandbox Only'}
                </button>
              </div>
              <p className="muted">Review containers, VMs, or sites created during recruiter evaluations for cleanup:</p>
              <ul className="sandbox-list">
                {sandboxSummary.recent.map((item) => {
                  const itemActor = auditActor(item);
                  const sbLabel = auditSandboxLabel(item);
                  return (
                    <li key={item.id}>
                      <span className="role-badge guest">@{itemActor.username}</span>
                      <span className="mono">{item.action}</span>
                      <strong>{item.target || '—'}</strong>
                      {sbLabel && <span className="chip">{sbLabel}</span>}
                      <span className="muted mono">{formatDateTime(item.at)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="panel audit-filter-panel">
            <form
              className="audit-filters"
              onSubmit={(e) => {
                e.preventDefault();
                void loadAudit();
              }}
            >
              <label className="users-search">
                <Icon name="search" className="icon-xs" />
                <input
                  type="search"
                  value={auditQuery}
                  onChange={(e) => setAuditQuery(e.target.value)}
                  placeholder="Search actor, action, target, IP…"
                  aria-label="Search audit logs"
                />
              </label>
              <select value={auditRole} onChange={(e) => setAuditRole(e.target.value)} aria-label="Filter by role">
                <option value="">All roles</option>
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="recruiter_guest">Recruiter Guest</option>
                <option value="player">Player</option>
              </select>
              <select
                value={auditCategory}
                onChange={(e) => setAuditCategory(e.target.value as ActionCategory)}
                aria-label="Filter by action category"
              >
                <option value="">All actions</option>
                <option value="auth">Auth</option>
                <option value="users">Users</option>
                <option value="compute">VMs &amp; Containers</option>
                <option value="sites">Sites &amp; Routes</option>
                <option value="ops">Updates &amp; Settings</option>
              </select>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={auditSandboxOnly}
                  onChange={(e) => setAuditSandboxOnly(e.target.checked)}
                />
                Sandbox Only
              </label>
              <button type="submit" className="ghost" disabled={loadingAudit}>
                <Icon name="refresh" className="icon-xs" />
                {loadingAudit ? 'Refreshing…' : 'Refresh'}
              </button>
            </form>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2><Icon name="activity" />Chronological Audit Trail <span className="count">{filteredLogs.length}</span></h2>
            </div>
            <div className="audit-table-wrap">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Status</th>
                    <th>IP</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((entry) => {
                    const actor = auditActor(entry);
                    const sbLabel = auditSandboxLabel(entry);
                    const roleBadgeCls = ROLE_META[actor.role as AuthRole]?.cls ?? 'player';
                    const detailsText =
                      entry.details && typeof entry.details === 'object' && Object.keys(entry.details as Record<string, unknown>).length > 0
                        ? JSON.stringify(entry.details, null, 2)
                        : typeof entry.details === 'string' && entry.details
                          ? entry.details
                          : '';
                    return (
                      <tr key={entry.id} className={sbLabel ? 'sandbox-row' : ''}>
                        <td className="mono nowrap" title={entry.at}>{formatDateTime(entry.at)}</td>
                        <td>
                          <div className="actor-cell">
                            <span className="mono">{actor.username}</span>
                            {actor.role && <span className={`role-badge ${roleBadgeCls}`}>{actor.role}</span>}
                          </div>
                        </td>
                        <td>
                          <span className="chip mono">{entry.action}</span>
                          {sbLabel && <span className="chip sandbox-chip">{sbLabel}</span>}
                        </td>
                        <td className="mono">{entry.target || '—'}</td>
                        <td>
                          <span className={`status-pill ${statusClass(entry.status)}`}>{entry.status}</span>
                        </td>
                        <td className="mono dim">{entry.ip || '—'}</td>
                        <td>
                          {detailsText ? (
                            <details className="audit-details">
                              <summary>JSON</summary>
                              <pre>{detailsText}</pre>
                            </details>
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredLogs.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted audit-empty">
                        {loadingAudit ? 'Loading audit log…' : 'No audit entries match the current filters.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
