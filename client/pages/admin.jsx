import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dateTime, naira, num, plural, useApp, useFetch, useLive } from '../lib.jsx';
import {
  Dialog, ErrorNote, Field, Loading, PLATFORM_NAMES, Portrait,
} from '../ui.jsx';
import { THEMES } from '../themes.js';
import { bulkPrice } from '../../shared/pricing.js';

const TABS = [
  ['overview', 'Overview'],
  ['contestants', 'Contestants'],
  ['money', 'Payments & votes'],
  ['review', 'Review'],
  ['competition', 'Competition'],
  ['messages', 'Messages'],
  ['enquiries', 'Enquiries'],
  ['reports', 'Reports'],
  ['account', 'Your login'],
];

export function Admin() {
  const { setUser } = useApp();
  const [tab, setTab] = useState('overview');
  const { data: overview, reload } = useFetch('/admin/overview');

  // The site has no admin link, so logging out happens here.
  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    window.location.assign('/');
  }
  useLive('leaderboard', reload);
  useLive('admin', reload);
  return (
    <div className="wrap page admin">
      <div className="page-head admin-head">
        <h1>Control panel</h1>
        <button type="button" className="btn btn-ghost btn-small" onClick={logout}>Log out</button>
      </div>
      <div className="tabs admin-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); reload(); }}>
            {label}
            {key === 'contestants' && overview?.pending ? <span className="badge">{overview.pending}</span> : null}
            {key === 'review' && overview?.openFlags ? <span className="badge">{overview.openFlags}</span> : null}
            {key === 'enquiries' && overview?.newEnquiries ? <span className="badge">{overview.newEnquiries}</span> : null}
          </button>
        ))}
      </div>
      {tab === 'overview' ? <Overview data={overview} go={setTab} /> : null}
      {tab === 'contestants' ? <ContestantsTab onChange={reload} /> : null}
      {tab === 'money' ? <MoneyTab onChange={reload} /> : null}
      {tab === 'review' ? <ReviewTab onChange={reload} /> : null}
      {tab === 'competition' ? <CompetitionTab onChange={reload} /> : null}
      {tab === 'messages' ? <MessagesTab /> : null}
      {tab === 'enquiries' ? <EnquiriesTab onChange={reload} /> : null}
      {tab === 'reports' ? <ReportsTab /> : null}
      {tab === 'account' ? <AccountTab /> : null}
    </div>
  );
}

function Overview({ data, go }) {
  if (!data) return <Loading />;
  return (
    <>
      <dl className="tiles tiles-3">
        <div><dt>Revenue</dt><dd>{naira(data.revenue)}</dd><small>{naira(data.revenue24h)} in 24 hrs{data.revenueInPerson ? ` · ${naira(data.revenueInPerson)} in person` : ''}</small></div>
        <div><dt>Paid votes</dt><dd>{num(data.totalVotes)}</dd><small>{num(data.votes24h)} in 24 hrs{data.adjustedVotes ? ` · ${data.adjustedVotes > 0 ? '+' : ''}${num(data.adjustedVotes)} by admins` : ''}</small></div>
        <div><dt>Active contestants</dt><dd>{num(data.contestants)}</dd><small>{num(data.pending)} waiting for review</small></div>
      </dl>
      <section className="panel">
        <h2>Needs your attention</h2>
        <ul className="todo">
          <li><button type="button" className="text-link as-button" onClick={() => go('contestants')}>{num(data.pending)} applications waiting for review</button></li>
          {data.waitingForGroup ? <li><button type="button" className="text-link as-button" onClick={() => go('competition')}>{plural(data.waitingForGroup, 'contestant')} waiting for a WhatsApp group</button></li> : null}
          {data.newEnquiries ? <li><button type="button" className="text-link as-button" onClick={() => go('enquiries')}>{num(data.newEnquiries)} new {data.newEnquiries === 1 ? 'enquiry' : 'enquiries'}</button></li> : null}
          <li><button type="button" className="text-link as-button" onClick={() => go('review')}>{num(data.openFlags)} open fraud flags</button></li>
          <li><button type="button" className="text-link as-button" onClick={() => go('money')}>{num(data.paymentsInReview)} payments in review, {num(data.votesHeld)} held for refund</button></li>
          <li>Voting status: <b>{data.voting.status}</b>. <button type="button" className="text-link as-button" onClick={() => go('competition')}>Change</button></li>
        </ul>
      </section>
    </>
  );
}

function ActionDialog({ action, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(''); setError(null); }, [action]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action.run({ reason });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(action)} onClose={onClose} title={action?.title ?? ''}>
      <form className="stack" onSubmit={submit}>
        {action?.description ? <p>{action.description}</p> : null}
        {action?.needsReason !== false ? (
          <Field label={action?.reasonLabel ?? 'Reason'}>
            <textarea rows={3} required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        ) : null}
        <ErrorNote error={error} />
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={busy}>{busy ? 'Working…' : action?.confirm ?? 'Confirm'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function ContestantsTab({ onChange }) {
  const [status, setStatus] = useState('pending');
  const [q, setQ] = useState('');
  // A page at a time: with thousands of applications, the whole list would be slow to load.
  const [limit, setLimit] = useState(200);
  useEffect(() => { setLimit(200); }, [status, q]);
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (q) query.set('q', q);
  query.set('limit', limit);
  const { data, error, reload } = useFetch(`/admin/contestants?${query}`);
  const [action, setAction] = useState(null);
  const [opened, setOpened] = useState(null);
  const [actionError, setActionError] = useState(null);
  const refresh = () => { reload(); onChange(); };

  async function approve(c) {
    setActionError(null);
    try {
      await api(`/admin/contestants/${c.id}/approve`, { method: 'POST' });
      refresh();
    } catch (err) {
      setActionError(err);
    }
  }
  async function resend(c) {
    setActionError(null);
    try {
      await api(`/admin/contestants/${c.id}/resend-code`, { method: 'POST' });
    } catch (err) {
      setActionError(err);
    }
  }
  async function simple(c, path, body = {}) {
    setActionError(null);
    try {
      await api(`/admin/contestants/${c.id}/${path}`, { body });
      refresh();
    } catch (err) {
      setActionError(err);
    }
  }
  async function setCategory(c, category) {
    await api(`/admin/contestants/${c.id}`, { method: 'PATCH', body: { category } }).catch(setActionError);
    reload();
  }
  const statusAction = (c, verb, title, description) => setAction({
    title,
    description,
    confirm: title,
    needsReason: verb !== 'reinstate',
    reasonLabel: 'Reason (the contestant will see this)',
    run: ({ reason }) => api(`/admin/contestants/${c.id}/${verb}`, { body: { reason } }),
  });

  return (
    <>
      <div className="filters">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {['pending', 'approved', 'rejected', 'suspended', 'disqualified', 'eliminated'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Search name, code or email"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      </div>
      <ErrorNote error={error ?? actionError} />
      {!data ? <Loading /> : data.length === 0 ? <p className="muted empty">Nothing here{status === 'pending' ? ': the review queue is clear' : ''}.</p> : (
        <ul className="admin-list">
          {data.map((c) => (
            <li key={c.id} className="admin-card">
              <div className="admin-card-head">
                <Portrait name={c.stageName} photoUrl={c.photoUrl} code={c.code ?? c.stageName} className="admin-photo" />
                <div className="admin-card-who">
                  <strong>{c.stageName}</strong> <em className={`tag tag-${c.status}`}>{c.status}</em>
                  {c.verification === 'passed' ? <em className="tag tag-approved">Followers passed</em> : null}
                  {c.verification === 'review' ? <em className="tag tag-review">Check followers by hand</em> : null}
                  {c.onProbation ? <em className="tag tag-review">On probation</em> : null}
                  {c.pendingStageName || c.pendingPhotoUrl ? <em className="tag tag-review">Profile change waiting</em> : null}
                  <small>{c.code ?? 'No code yet'}{c.position ? ` · position ${c.position} · ${num(c.totalVotes)} votes` : ''}</small>
                  <small>{c.location}, {c.state} · applied {dateTime(c.createdAt)}</small>
                </div>
                <div className="admin-actions">
                  {c.status === 'pending' || c.status === 'rejected' ? <button type="button" className="btn btn-primary btn-small" onClick={() => approve(c)}>Approve</button> : null}
                  {c.status === 'pending' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => statusAction(c, 'reject', 'Reject application')}>Reject</button> : null}
                  {c.status === 'approved' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => statusAction(c, 'suspend', 'Suspend contestant', 'The profile disappears from the public site and cannot receive votes.')}>Suspend</button> : null}
                  {c.status === 'approved' || c.status === 'suspended' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => statusAction(c, 'disqualify', 'Disqualify contestant', 'Removed from the leaderboard. The code is never reassigned.')}>Disqualify</button> : null}
                  {['suspended', 'disqualified', 'eliminated'].includes(c.status) ? <button type="button" className="btn btn-ghost btn-small" onClick={() => statusAction(c, 'reinstate', 'Reinstate contestant', 'Returns to the leaderboard with the existing votes and code.')}>Reinstate</button> : null}
                  <button type="button" className="btn btn-ghost btn-small" aria-expanded={opened === c.id} onClick={() => setOpened(opened === c.id ? null : c.id)}>{opened === c.id ? 'Hide' : 'Details'}</button>
                </div>
              </div>
              {opened === c.id ? (
                <div className="admin-details">
                  <dl>
                    <div><dt>Full name</dt><dd>{c.fullName}</dd></div>
                    <div><dt>Email</dt><dd>{c.email}</dd></div>
                    <div><dt>Phone</dt><dd>{c.phone}</dd></div>
                    <div><dt>WhatsApp</dt><dd>{c.whatsapp}</dd></div>
                    <div><dt>Socials</dt><dd className="social-links">
                      {c.tiktok ? <a href={c.tiktok} target="_blank" rel="noreferrer noopener">TikTok</a> : null}
                      {c.instagram ? <a href={c.instagram} target="_blank" rel="noreferrer noopener">Instagram</a> : null}
                      {c.facebook ? <a href={c.facebook} target="_blank" rel="noreferrer noopener">Facebook</a> : null}
                      {!c.tiktok && !c.instagram && !c.facebook ? 'None given' : null}
                    </dd></div>
                    {c.followerResults.length ? (
                      <div><dt>Followers</dt><dd>{c.followerResults.map((r) => `${PLATFORM_NAMES[r.platform]}: ${r.status === 'found' ? num(r.followers) : r.status === 'missing' ? 'not found' : r.status === 'skipped' ? 'not checked, another account passed' : 'could not be read'}`).join(' · ')}</dd></div>
                    ) : null}
                    {c.whatsappGroupName ? <div><dt>WhatsApp group</dt><dd>{c.whatsappGroupName}</dd></div> : null}
                    {c.adjustedVotes ? <div><dt>Votes changed by admins</dt><dd>{c.adjustedVotes > 0 ? '+' : ''}{num(c.adjustedVotes)} of {num(c.totalVotes)}</dd></div> : null}
                    {c.statusReason ? <div><dt>Reason</dt><dd>{c.statusReason}</dd></div> : null}
                  </dl>
                  <p className="admin-bio">{c.bio}</p>
                  <div className="inline-form">
                    <Field label="Category / group"><input defaultValue={c.category ?? ''} onBlur={(e) => { if (e.target.value !== (c.category ?? '')) setCategory(c, e.target.value); }} /></Field>
                    {c.status === 'approved' ? <button type="button" className="btn btn-ghost" onClick={() => resend(c)}>Resend code &amp; link</button> : null}
                    {c.status === 'approved' ? <Link className="btn btn-ghost" to={`/c/${c.code}`}>Public profile</Link> : null}
                    {c.status === 'approved' ? <button type="button" className="btn btn-ghost" onClick={() => simple(c, 'probation', { on: !c.onProbation })}>{c.onProbation ? 'End probation' : 'Put on probation'}</button> : null}
                    <button type="button" className="btn btn-ghost" onClick={() => simple(c, 'reset-pin')}>{c.hasPin ? 'Reset PIN' : 'No PIN set'}</button>
                  </div>
                  {c.pendingStageName || c.pendingPhotoUrl ? (
                    <div className="profile-change">
                      <h3>Profile change waiting</h3>
                      {c.pendingPhotoUrl ? <img src={c.pendingPhotoUrl} alt={`New photo for ${c.stageName}`} /> : null}
                      {c.pendingStageName ? <p>New name: <b>{c.pendingStageName}</b> (now {c.stageName})</p> : null}
                      <div className="admin-actions">
                        <button type="button" className="btn btn-primary btn-small" onClick={() => simple(c, 'profile-changes/approve')}>Approve change</button>
                        <button type="button" className="btn btn-ghost btn-small" onClick={() => simple(c, 'profile-changes/reject')}>Reject</button>
                      </div>
                    </div>
                  ) : null}
                  {c.status === 'approved' ? <VoteAdjuster contestant={c} onDone={refresh} /> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {data && data.length >= limit ? (
        <div className="show-more">
          <p className="muted small-note">Showing the first {num(data.length)}.</p>
          <button type="button" className="btn btn-ghost" onClick={() => setLimit(limit + 200)}>Show more</button>
        </div>
      ) : null}
      <ActionDialog action={action} onClose={() => setAction(null)} onDone={() => { setAction(null); refresh(); }} />
    </>
  );
}

const IN_PERSON_METHODS = ['Cash', 'Bank transfer', 'POS', 'Other'];

// Votes someone buys from an admin in person. They count like any payment, and the buyer gets a
// proof of vote and receipt.
function InPersonSale({ onDone }) {
  const { competition } = useApp();
  const [code, setCode] = useState('');
  const [who, setWho] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const votes = Number(quantity);
  // The server charges the same price, bulk deals included.
  const price = Number.isInteger(votes) && votes > 0 ? bulkPrice(votes, competition?.votePrice ?? 0, competition?.packages ?? []) : null;

  async function lookUp() {
    setWho(null);
    if (!code.trim()) return;
    try {
      const c = await api(`/contestants/${encodeURIComponent(code.trim())}`);
      setWho({ name: c.name, code: c.code });
    } catch (err) {
      setWho({ error: err.message });
    }
  }

  async function submit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const sale = await api('/admin/in-person-votes', {
        body: { code, quantity: votes, method: f.get('method'), voterName: f.get('voterName') },
      });
      setDone({ ...sale, name: who?.name ?? code, voter: f.get('voterName') });
      form.reset();
      setCode('');
      setWho(null);
      setQuantity('');
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel in-person">
      <h2>Record votes bought in person</h2>
      <p className="muted">For supporters who pay you directly, with cash, a transfer or POS. The votes count at once, show in revenue, and the supporter gets a proof of vote like anyone paying online.</p>
      {competition?.voting && !competition.voting.open ? <p className="note">{competition.voting.message} Votes can only be sold while voting is open.</p> : null}
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Contestant code" hint={who?.name ? `${who.name} (${who.code})` : who?.error ?? 'For example MBG013'}>
            <input value={code} onChange={(e) => { setCode(e.target.value); setWho(null); }} onBlur={lookUp} required />
          </Field>
          <Field label="Votes" hint={price !== null ? `Collect ${naira(price)}` : 'The price includes bulk deals.'}>
            <input type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </Field>
          <Field label="Paid by">
            <select name="method" defaultValue="Cash">
              {IN_PERSON_METHODS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Voter’s name" hint="Goes on their proof of vote."><input name="voterName" required /></Field>
        </div>
        <ErrorNote error={error} />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Recording…' : price !== null ? `Record ${num(votes)} votes for ${naira(price)}` : 'Record votes'}</button>
      </form>
      {done ? (
        <div className="note note-good in-person-done">
          <p><b>{num(done.votes)} votes for {done.name}</b> recorded, {naira(done.amount)} from {done.voter}.{done.votesStatus === 'held' ? ' The votes could not be counted, so refund the money.' : ''}</p>
          <p>
            <a href={`/pay/return/${done.reference}`} target="_blank" rel="noreferrer">Open their proof of vote</a>
            {' · '}
            <Link to={`/receipt/payment/${done.reference}`}>Receipt</Link>
          </p>
        </div>
      ) : null}
    </section>
  );
}

function MoneyTab({ onChange }) {
  const [view, setView] = useState('payments');
  const payments = useFetch(view === 'payments' ? '/admin/payments' : null);
  const votes = useFetch(view === 'votes' ? '/admin/votes' : null);
  const [action, setAction] = useState(null);
  return (
    <>
      <InPersonSale onDone={() => { payments.reload(); onChange(); }} />
      <div className="qty-chips">
        <button type="button" className={`chip ${view === 'payments' ? 'active' : ''}`} onClick={() => setView('payments')}>Payments</button>
        <button type="button" className={`chip ${view === 'votes' ? 'active' : ''}`} onClick={() => setView('votes')}>Votes</button>
      </div>
      {view === 'payments' ? (
        !payments.data ? <Loading /> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Date</th><th>Reference</th><th>Voter</th><th>Contestant</th><th>Receipt email</th><th className="num">Votes</th><th className="num">Amount</th><th>Status</th></tr></thead>
              <tbody>
                {payments.data.map((p) => (
                  <tr key={p.reference}>
                    <td>{dateTime(p.createdAt)}</td>
                    <td>{p.status === 'paid' ? <Link to={`/receipt/payment/${p.reference}`}>{p.reference}</Link> : p.reference}</td>
                    <td>{p.voterName ?? '—'}</td>
                    <td>{p.contestant ?? '—'}</td>
                    <td>{p.email ?? '—'}</td>
                    <td className="num">{num(p.votes)}</td>
                    <td className="num">{naira(p.amount)}</td>
                    <td><em className={`tag tag-${p.status}`}>{p.status}</em>{p.provider === 'in_person' ? <em className="tag" title={`${p.method ?? ''}${p.recordedBy ? `, recorded by ${p.recordedBy}` : ''}`}>in person</em> : null}{p.votesStatus === 'held' ? <em className="tag tag-review">refund due</em> : null}</td>
                  </tr>
                ))}
                {payments.data.length === 0 ? <tr><td colSpan="8" className="muted">No payments yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        )
      ) : (
        !votes.data ? <Loading /> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Date</th><th>Receipt</th><th>Contestant</th><th className="num">Votes</th><th>Receipt email</th><th>Status</th><th><span className="visually-hidden">Action</span></th></tr></thead>
              <tbody>
                {votes.data.map((v) => (
                  <tr key={v.id}>
                    <td>{dateTime(v.createdAt)}</td>
                    <td><Link to={`/receipt/vote/${v.receiptNo}`}>{v.receiptNo}</Link></td>
                    <td>{v.name} ({v.code})</td>
                    <td className="num">{num(v.quantity)}</td>
                    <td>{v.email ?? '—'}</td>
                    <td><em className={`tag tag-${v.status}`}>{v.status}</em></td>
                    <td>
                      {v.status === 'valid' ? (
                        <button
                          type="button"
                          className="text-link as-button"
                          onClick={() => setAction({
                            title: 'Void this vote',
                            description: `Removes ${v.quantity} votes from ${v.name} and recalculates the leaderboard. Any refund is done separately in Paystack.`,
                            confirm: 'Void vote',
                            run: ({ reason }) => api(`/admin/votes/${v.id}/void`, { body: { reason } }),
                          })}
                        >Void</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {votes.data.length === 0 ? <tr><td colSpan="7" className="muted">No votes yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        )
      )}
      <ActionDialog action={action} onClose={() => setAction(null)} onDone={() => { setAction(null); votes.reload(); onChange(); }} />
    </>
  );
}

function ReviewTab({ onChange }) {
  const [status, setStatus] = useState('open');
  const { data, reload, error } = useFetch(`/admin/flags?status=${status}`);
  const close = async (id, outcome) => { await api(`/admin/flags/${id}/${outcome}`, { method: 'POST' }); reload(); onChange(); };
  return (
    <>
      <p className="muted">Suspicious patterns are flagged here automatically. Nothing is blocked until you decide. To remove votes, void them under Payments &amp; votes.</p>
      <div className="qty-chips">
        {['open', 'resolved', 'dismissed'].map((s) => <button key={s} type="button" className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>{s}</button>)}
      </div>
      <ErrorNote error={error} />
      {!data ? <Loading /> : data.length === 0 ? <p className="muted empty">Nothing to review.</p> : (
        <ul className="admin-list">
          {data.map((f) => (
            <li key={f.id} className="admin-card flag">
              <div>
                <strong>{f.kind.replace(/_/g, ' ')}</strong> <em className={`tag tag-sev-${f.severity}`}>{f.severity}</em>
                <p>{f.details}</p>
                <small className="muted">{dateTime(f.createdAt)}{f.code ? ` · ${f.code}` : ''}</small>
              </div>
              <div className="admin-actions">
                {f.status === 'open' ? (
                  <>
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => close(f.id, 'dismissed')}>Dismiss</button>
                    <button type="button" className="btn btn-primary btn-small" onClick={() => close(f.id, 'resolved')}>Mark resolved</button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function PackageRow({ pack, reload, setError }) {
  const save = async (changes) => {
    try {
      await api(`/admin/packages/${pack.id}`, { method: 'PATCH', body: changes });
      reload();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <tr>
      <td><input aria-label="Votes" type="number" min="1" defaultValue={pack.votes} onBlur={(e) => { const v = Number(e.target.value); if (v !== pack.votes) save({ votes: v }); }} /></td>
      <td><input aria-label="Price in naira" type="number" min="1" defaultValue={pack.price} onBlur={(e) => { const v = Number(e.target.value); if (v !== pack.price) save({ price: v }); }} /></td>
      <td className="num">{naira(Math.round(pack.price / pack.votes))}</td>
      <td><button type="button" className="text-link as-button" onClick={() => save({ active: !pack.active })}>{pack.active ? 'Hide' : 'Show'}</button> <small className="muted">{pack.active ? 'on sale' : 'hidden'}</small></td>
    </tr>
  );
}

// A bigger deal should never cost more per vote than a smaller one, or it is a worse deal.
function dealProblems(packages, votePrice) {
  const deals = packages.filter((p) => p.active).sort((a, b) => a.votes - b.votes);
  const notes = [];
  deals.forEach((d, i) => {
    const rate = d.price / d.votes;
    if (rate >= votePrice) notes.push(`${num(d.votes)} votes for ${naira(d.price)} is no cheaper than the normal ${naira(votePrice)} a vote, so it gives no discount.`);
    const smaller = deals.slice(0, i).find((s) => s.price / s.votes < rate);
    if (smaller) {
      notes.push(`${num(d.votes)} votes for ${naira(d.price)} costs ${naira(Math.round(rate))} a vote, more than the ${naira(Math.round(smaller.price / smaller.votes))} a vote on ${num(smaller.votes)} votes. Buying ${num(d.votes)} costs more than buying ${num(d.votes - 1)}.`);
    }
  });
  return notes;
}

// Votes an admin adds or takes away, for example for an offline payment or a correction.
// Every change needs a reason and stays in the log.
function VoteAdjuster({ contestant, onDone }) {
  const { data, reload } = useFetch(`/admin/contestants/${contestant.id}/adjustments`);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const sign = f.get('direction') === 'remove' ? -1 : 1;
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/contestants/${contestant.id}/adjustments`, { body: { quantity: sign * Number(f.get('quantity')), reason: f.get('reason') } });
      form.reset();
      reload();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vote-adjuster">
      <h3>Add or remove votes</h3>
      <p className="muted small-note">Changes the total straight away, without a payment. Each change is logged with your reason.</p>
      <form className="inline-form" onSubmit={submit}>
        <Field label="Change">
          <select name="direction" defaultValue="add">
            <option value="add">Add votes</option>
            <option value="remove">Remove votes</option>
          </select>
        </Field>
        <Field label="Votes"><input name="quantity" type="number" min="1" step="1" required /></Field>
        <Field label="Reason"><input name="reason" placeholder="e.g. paid by bank transfer" minLength={3} required /></Field>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
      <ErrorNote error={error} />
      {data?.length ? (
        <ul className="adjustment-log">
          {data.map((a) => (
            <li key={a.id}>
              <b className={a.quantity > 0 ? 'up' : 'down'}>{a.quantity > 0 ? '+' : ''}{num(a.quantity)}</b>
              <span>{a.reason}</span>
              <small>{a.admin ?? 'Admin'} · {dateTime(a.createdAt)}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EnquiriesTab({ onChange }) {
  const { data, reload } = useFetch('/admin/enquiries');
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  useLive('admin', reload);

  async function mark(enquiry, status) {
    setError(null);
    try {
      await api(`/admin/enquiries/${enquiry.id}/${status}`, { method: 'POST' });
      reload();
      onChange();
    } catch (err) {
      setError(err);
    }
  }

  async function saveContact(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setSaved(false);
    try {
      await api('/admin/contact', { method: 'PUT', body: { phone: f.get('phone'), email: f.get('email') } });
      setSaved(true);
      reload();
    } catch (err) {
      setError(err);
    }
  }

  if (!data) return <Loading />;
  return (
    <div className="admin-columns">
      <ErrorNote error={error} />
      <section className="panel">
        <h2>Sponsorship and enquiries</h2>
        <p className="muted">Messages sent from the Sponsorship / Enquiry page. Each one is also emailed to the admins.</p>
        {data.enquiries.length === 0 ? <p className="muted empty">No enquiries yet.</p> : (
          <ul className="admin-list">
            {data.enquiries.map((q) => (
              <li key={q.id} className={`admin-card enquiry-card ${q.status}`}>
                <div className="enquiry-head">
                  <div>
                    <strong>{q.name}</strong>{q.organisation ? ` · ${q.organisation}` : ''}
                    <em className={`tag ${q.status === 'new' ? 'tag-review' : ''}`}>{q.status === 'new' ? 'New' : 'Done'}</em>
                    <small>{q.kind} · {dateTime(q.createdAt)}</small>
                  </div>
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => mark(q, q.status === 'new' ? 'done' : 'new')}>{q.status === 'new' ? 'Mark as done' : 'Mark as new'}</button>
                </div>
                <p className="enquiry-message">{q.message}</p>
                <p className="enquiry-contact">
                  <a href={`tel:${q.phone.replace(/[^\d+]/g, '')}`}>{q.phone}</a>
                  {' · '}<a href={`https://wa.me/${q.phone.replace(/\D/g, '').replace(/^0/, '234')}`} target="_blank" rel="noreferrer noopener">WhatsApp</a>
                  {q.email ? <>{' · '}<a href={`mailto:${q.email}`}>{q.email}</a></> : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Contact details on the page</h2>
        <p className="muted">Optional. Shown under the enquiry form for people who would rather call or email.</p>
        <form className="inline-form" onSubmit={saveContact}>
          <Field label="Phone or WhatsApp"><input name="phone" type="tel" defaultValue={data.contact.phone} /></Field>
          <Field label="Email"><input name="email" type="email" defaultValue={data.contact.email} /></Field>
          <button className="btn btn-ghost">Save</button>
        </form>
        {saved ? <p className="note note-good">Saved.</p> : null}
      </section>
    </div>
  );
}

const CHECK_MODES = {
  live: 'Follower counts are read automatically when someone applies, by the services below in order. When one has no answer or runs out of free credits, the next takes over. If none can read an account, the application comes to you marked “Check followers by hand”.',
  test: 'Test mode: follower counts are made up, because no service key has been added yet. Add at least one key below to read real counts.',
  manual: 'No service key has been added, so every application waits for you to check the accounts by hand.',
};

const PLATFORM_SHORT = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' };

// How follower counts are read: the chain of services, choosing to check by hand, and a test.
function FollowerCheckPanel({ data, reload }) {
  const { refreshCompetition } = useApp();
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [trial, setTrial] = useState(null);
  const [testing, setTesting] = useState(false);

  async function save(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setSaved(false);
    try {
      await api('/admin/joining', { method: 'PUT', body: { minFollowers: Number(f.get('minFollowers')), checkMode: f.get('checkMode') } });
      setSaved(true);
      reload();
      refreshCompetition({ fresh: true });
    } catch (err) {
      setError(err);
    }
  }

  async function test(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setTrial(null);
    setTesting(true);
    try {
      setTrial(await api('/admin/followers/test', { body: { platform: f.get('platform'), account: f.get('account') } }));
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setTesting(false);
    }
  }

  async function resume(name) {
    await api(`/admin/followers/providers/${name}/resume`, { method: 'POST' }).catch(setError);
    reload();
  }

  const label = (name) => data.providers.find((p) => p.name === name)?.label ?? name;
  return (
    <>
      <h2>Follower check</h2>
      <p className="muted">{data.checkSetting === 'manual' ? 'You chose to check every application by hand.' : CHECK_MODES[data.checkMode]}</p>
      <form className="stack" onSubmit={save}>
        <div className="form-grid">
          <Field label="Followers needed" hint="On at least one of Instagram, TikTok or Facebook.">
            <input key={data.minFollowers} name="minFollowers" type="number" min="0" defaultValue={data.minFollowers} required />
          </Field>
          <Field label="How followers are checked">
            <select key={data.checkSetting} name="checkMode" defaultValue={data.checkSetting}>
              <option value="auto">Automatically, with the services below</option>
              <option value="manual">By hand, by an admin</option>
            </select>
          </Field>
        </div>
        <button className="btn btn-ghost">Save</button>
      </form>
      {saved ? <p className="note note-good">Saved.</p> : null}
      <ErrorNote error={error} />

      <h3>Services, in the order they are tried</h3>
      <div className="table-wrap">
        <table className="data-table services-table">
          <thead><tr><th>Service</th><th>Reads</th><th>Status</th><th className="num">Checks (30 days)</th></tr></thead>
          <tbody>
            {data.providers.map((p) => (
              <tr key={p.name}>
                <td><b>{p.label}</b></td>
                <td>{p.platforms.map((x) => PLATFORM_SHORT[x]).join(', ')}</td>
                <td>
                  {!p.configured ? <span className="muted">Not set up. Add <code>{p.env}</code> on Vercel.</span> : null}
                  {p.configured && p.pausedUntil ? <><em className="tag tag-review">Out of credits</em> <small className="muted">skipped until {dateTime(p.pausedUntil)}</small> <button type="button" className="text-link as-button" onClick={() => resume(p.name)}>Try again now</button></> : null}
                  {p.configured && !p.pausedUntil ? <em className="tag tag-approved">Ready</em> : null}
                  {p.configured && p.credits !== null ? <small className="muted"> {num(p.credits)} credits left</small> : null}
                </td>
                <td className="num">{num(p.used30d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Test an account</h3>
      <form className="inline-form" onSubmit={test}>
        <Field label="Network">
          <select name="platform" defaultValue="instagram">
            {Object.entries(PLATFORM_SHORT).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
        </Field>
        <Field label="Username or link"><input name="account" placeholder="@username" required /></Field>
        <button className="btn btn-primary" disabled={testing}>{testing ? 'Checking…' : 'Check'}</button>
      </form>
      {trial ? (
        <div className="note follower-trial">
          <p>
            <b>{trial.status === 'found' ? `${num(trial.followers)} followers` : trial.status === 'missing' ? 'Account not found' : 'Could not be read'}</b>
            {trial.source && trial.source !== 'test' ? ` · read by ${label(trial.source)}` : ''}
            {trial.source === 'test' ? ' · test mode, made-up count' : ''}
          </p>
          {trial.attempts?.length ? (
            <ul>
              {trial.attempts.map((a) => (
                <li key={a.provider}>{label(a.provider)}: {a.status === 'found' ? `${num(a.followers)} followers` : a.detail ?? a.status}{a.ms ? ` (${(a.ms / 1000).toFixed(1)}s)` : ''}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function GroupRow({ group, onSave }) {
  const [editing, setEditing] = useState(false);
  const full = group.used >= group.capacity;

  async function save(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (await onSave({ ...group, name: f.get('name'), url: f.get('url'), capacity: Number(f.get('capacity')) })) setEditing(false);
  }

  return (
    <li className="group-row">
      <div className="group-row-head">
        <div>
          <strong>{group.name}</strong>
          {group.current ? <em className="tag tag-approved">Giving out now</em> : null}
          {group.closed ? <em className="tag">Closed</em> : full ? <em className="tag tag-review">Full</em> : null}
          <small>{num(group.used)} of {num(group.capacity)} places given out</small>
        </div>
        <div className="admin-actions">
          <button type="button" className="btn btn-ghost btn-small" onClick={() => onSave({ ...group, closed: !group.closed })}>{group.closed ? 'Reopen' : 'Mark as full'}</button>
          <button type="button" className="btn btn-ghost btn-small" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Cancel' : 'Edit'}</button>
        </div>
      </div>
      <div className="group-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (group.used / group.capacity) * 100)}%` }} /></div>
      {editing ? (
        <form className="inline-form" onSubmit={save}>
          <Field label="Name"><input name="name" defaultValue={group.name} required /></Field>
          <Field label="Invite link"><input name="url" type="url" defaultValue={group.url} required /></Field>
          <Field label="Places"><input name="capacity" type="number" min="1" max="1024" defaultValue={group.capacity} required /></Field>
          <button className="btn btn-primary">Save</button>
        </form>
      ) : <p className="group-link"><a href={group.url} target="_blank" rel="noreferrer noopener">{group.url}</a></p>}
    </li>
  );
}

const ruleText = (r) => [
  r.keepTop ? `top ${num(r.keepTop)} stay` : null,
  r.minVotes ? `${num(r.minVotes)} votes needed${r.votesCounted === 'round' ? ' in the round' : ' in total'}` : null,
  r.probation ? `${num(r.probation)} on probation` : null,
].filter(Boolean).join(' · ');

// Rounds of voting. Each round's rules decide who goes through when it ends.
function RoundsPanel({ voting }) {
  const { data, reload } = useFetch('/admin/rounds');
  const [error, setError] = useState(null);
  const [action, setAction] = useState(null);
  useLive('leaderboard', reload);

  async function add(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const iso = (name) => (f.get(name) ? new Date(f.get(name)).toISOString() : '');
    setError(null);
    try {
      await api('/admin/rounds', {
        body: {
          name: f.get('name'), startsAt: iso('startsAt'), endsAt: iso('endsAt'), keepTop: f.get('keepTop'), minVotes: f.get('minVotes'),
          votesCounted: f.get('votesCounted'), probation: f.get('probation'),
        },
      });
      form.reset();
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function remove(round) {
    setError(null);
    await api(`/admin/rounds/${round.id}`, { method: 'DELETE' }).catch(setError);
    reload();
  }

  if (!data) return <section className="panel"><Loading /></section>;
  const current = data.rounds.find((r) => !r.closedAt);
  const preview = data.preview;
  return (
    <section className="panel">
      <h2>Rounds and eliminations</h2>
      <p className="muted">When a round ends, contestants who miss its rules are eliminated. Probation places let the next few below the cut stay in on a warning; anyone on probation who misses again is eliminated. Rounds end by themselves at their end time, during voting.</p>
      <ErrorNote error={error} />
      {data.rounds.length ? (
        <ul className="round-list">
          {data.rounds.map((r) => (
            <li key={r.id} className={r.closedAt ? 'closed' : r.id === current?.id ? 'current' : ''}>
              <div className="round-head">
                <div>
                  <strong>{r.name}</strong>
                  {r.closedAt ? <em className="tag">Ended</em> : r.id === current?.id ? <em className="tag tag-approved">{voting ? 'On now' : 'First up'}</em> : <em className="tag">Next</em>}
                  <small>{dateTime(r.startsAt)} to {dateTime(r.endsAt)} · {ruleText(r)}</small>
                  {r.result ? <small>{num(r.result.safe)} went through · {num(r.result.probation.length)} on probation · {num(r.result.eliminated.length)} eliminated</small> : null}
                </div>
                {!r.closedAt ? (
                  <div className="admin-actions">
                    {r.id === current?.id && voting ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={() => setAction({
                          title: `End ${r.name} now`,
                          description: preview ? `${num(preview.safe)} go through, ${num(preview.probation.length)} go on probation and ${num(preview.eliminated.length)} are eliminated. Everyone is told straight away.` : '',
                          confirm: 'End the round',
                          needsReason: false,
                          run: () => api(`/admin/rounds/${r.id}/close`, { method: 'POST' }),
                        })}
                      >End now</button>
                    ) : null}
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => remove(r)}>Remove</button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="muted empty">No rounds yet. Without rounds, voting simply runs until it closes.</p>}

      {preview && current ? (
        <div className="round-preview">
          <h3>If {current.name} ended now</h3>
          <p><b>{num(preview.safe)}</b> go through · <b>{num(preview.probation.length)}</b> on probation · <b>{num(preview.eliminated.length)}</b> eliminated</p>
          {preview.probation.length ? <p className="muted small-note">Probation: {preview.probation.map((c) => `${c.name} (${c.code})`).join(', ')}</p> : null}
          {preview.eliminated.length ? <p className="muted small-note">Eliminated: {preview.eliminated.slice(0, 30).map((c) => `${c.name} (${c.code})`).join(', ')}{preview.eliminated.length > 30 ? ` and ${num(preview.eliminated.length - 30)} more` : ''}</p> : null}
        </div>
      ) : null}

      <h3>Add a round</h3>
      <form className="stack" onSubmit={add}>
        <div className="form-grid">
          <Field label="Name"><input name="name" placeholder={`Round ${data.rounds.length + 1}`} required /></Field>
          <Field label="Starts" hint="Blank means when the last round ends, or now."><input name="startsAt" type="datetime-local" /></Field>
          <Field label="Ends"><input name="endsAt" type="datetime-local" required /></Field>
          <Field label="Keep the top" hint="Blank for no limit."><input name="keepTop" type="number" min="1" placeholder="e.g. 100" /></Field>
          <Field label="Minimum votes" hint="Blank for none."><input name="minVotes" type="number" min="1" placeholder="e.g. 500" /></Field>
          <Field label="Votes counted">
            <select name="votesCounted" defaultValue="round">
              <option value="round">Votes in this round</option>
              <option value="total">Total votes</option>
            </select>
          </Field>
          <Field label="Probation places" hint="How many just below the cut stay in on a warning."><input name="probation" type="number" min="0" defaultValue="0" /></Field>
        </div>
        <button className="btn btn-ghost">Add round</button>
      </form>
      <ActionDialog action={action} onClose={() => setAction(null)} onDone={() => { setAction(null); reload(); }} />
    </section>
  );
}

// Which looks visitors can switch between, and the one everyone sees first.
function ThemesPanel() {
  const { competition, refreshCompetition } = useApp();
  const current = competition?.themes;
  const [offered, setOffered] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  if (!current) return null;
  const ticked = offered ?? current.offered;
  const defaultTheme = ticked.includes(chosen ?? current.default) ? (chosen ?? current.default) : ticked[0];

  function toggle(id) {
    setSaved(false);
    setOffered(ticked.includes(id) ? ticked.filter((t) => t !== id) : [...ticked, id]);
  }

  async function save(e) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api('/admin/themes', { method: 'PUT', body: { offered: ticked, default: defaultTheme } });
      setSaved(true);
      setOffered(null);
      setChosen(null);
      refreshCompetition({ fresh: true });
    } catch (err) {
      setError(err);
    }
  }

  const swatch = (t) => ({ background: `linear-gradient(135deg, ${t.swatch[0]}, ${t.swatch[1]})` });
  return (
    <section className="panel">
      <h2>Site look</h2>
      <p className="muted">Tick the themes visitors can switch between with the Theme button. With only one ticked, the button is hidden and everyone sees that theme.</p>
      <form className="stack" onSubmit={save}>
        <div className="theme-admin-list">
          {THEMES.map((t) => (
            <label key={t.id} className={`theme-admin ${ticked.includes(t.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={ticked.includes(t.id)} onChange={() => toggle(t.id)} />
              <span className="theme-swatch" style={swatch(t)} />
              <span><b>{t.name}</b><small>{t.vibe}</small></span>
            </label>
          ))}
        </div>
        <Field label="New visitors see" hint="Visitors who picked a theme keep their pick, as long as it is still on offer.">
          <select value={defaultTheme} onChange={(e) => { setChosen(e.target.value); setSaved(false); }}>
            {THEMES.filter((t) => ticked.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <ErrorNote error={error} />
        {saved ? <p className="note note-good">Saved. Visitors see the change on their next page load.</p> : null}
        <button className="btn btn-ghost" disabled={!ticked.length}>Save look</button>
      </form>
    </section>
  );
}

function JoiningPanels() {
  const { data, reload } = useFetch('/admin/joining');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const placedNote = (placed) => (placed ? `Sent the link to ${plural(placed, 'waiting contestant')}.` : null);

  async function addGroup(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    setMessage(null);
    try {
      const { placed } = await api('/admin/whatsapp-groups', { body: { name: f.get('name'), url: f.get('url'), capacity: Number(f.get('capacity')) } });
      form.reset();
      setMessage(placedNote(placed) ?? 'Group added.');
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function saveGroup(group) {
    setError(null);
    setMessage(null);
    try {
      const { placed } = await api(`/admin/whatsapp-groups/${group.id}`, { method: 'PUT', body: group });
      setMessage(placedNote(placed));
      reload();
      return true;
    } catch (err) {
      setError(err);
      return false;
    }
  }

  if (!data) return <section className="panel"><Loading /></section>;
  const current = data.groups.find((g) => g.current);
  const nearlyFull = current && current.used >= current.capacity * 0.9 && !data.groups.some((g) => !g.closed && g.used < g.capacity && g.id !== current.id);

  return (
    <>
      <section className="panel">
        <FollowerCheckPanel data={data} reload={reload} />
      </section>
      <section className="panel">
        <h2>WhatsApp groups</h2>
        <p className="muted">People who pass the check get the link marked “Giving out now”. When a group is full, the next one on the list takes over.</p>
        <ErrorNote error={error} />
        {message ? <p className="note note-good">{message}</p> : null}
        {!current ? <p className="note note-error">No group has room. {data.waiting ? `Waiting for a link: ${num(data.waiting)}. ` : ''}Add a group below, and anyone waiting gets the link by email.</p> : null}
        {nearlyFull ? <p className="note">{current.name} is nearly full. Add the next group so nobody has to wait.</p> : null}
        {data.groups.length ? <ul className="group-rows">{data.groups.map((g) => <GroupRow key={g.id} group={g} onSave={saveGroup} />)}</ul> : null}
        <p className="muted small-note">“Places given out” counts people who received the link. WhatsApp does not tell the site who actually joined, so mark a group as full yourself if it fills up sooner.</p>
        <h3>Add a group</h3>
        <form className="inline-form" onSubmit={addGroup}>
          <Field label="Name"><input name="name" placeholder={`Batch ${data.groups.length + 1}`} required /></Field>
          <Field label="Invite link"><input name="url" type="url" placeholder="https://chat.whatsapp.com/…" required /></Field>
          <Field label="Places"><input name="capacity" type="number" min="1" max="1024" defaultValue="1000" required /></Field>
          <button className="btn btn-primary">Add group</button>
        </form>
      </section>
    </>
  );
}

function CompetitionTab({ onChange }) {
  const { refreshCompetition } = useApp();
  const { data, reload } = useFetch('/admin/settings');
  const results = useFetch('/results');
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [deadlineSaved, setDeadlineSaved] = useState(false);
  const [action, setAction] = useState(null);

  async function saveSettings(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setSaved(false);
    try {
      await api('/admin/settings', {
        method: 'PUT',
        body: {
          name: f.get('name'),
          votePrice: Number(f.get('votePrice')),
          largeVoteThreshold: Number(f.get('largeVoteThreshold')),
          startsAt: f.get('startsAt') ? new Date(f.get('startsAt')).toISOString() : '',
          endsAt: f.get('endsAt') ? new Date(f.get('endsAt')).toISOString() : '',
        },
      });
      setSaved(true);
      reload();
      refreshCompetition({ fresh: true });
    } catch (err) {
      setError(err);
    }
  }

  async function saveDeadline(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const value = f.get('registrationEndsAt');
    setError(null);
    setDeadlineSaved(false);
    try {
      const { started } = await api('/admin/registration', {
        method: 'PUT',
        body: { endsAt: value ? new Date(value).toISOString() : '', autoStart: f.get('autoStart') === 'on' },
      });
      setDeadlineSaved(started ? 'That time has passed, so voting has started.' : 'Saved. The countdown has been updated.');
      reload();
      onChange();
      refreshCompetition({ fresh: true });
    } catch (err) {
      setError(err);
    }
  }

  const asIso = (value) => (value ? new Date(value).toISOString() : '');

  async function saveVotingEnd(e) {
    e.preventDefault();
    setError(null);
    setDeadlineSaved(false);
    try {
      await api('/admin/voting-ends', { method: 'PUT', body: { endsAt: asIso(new FormData(e.currentTarget).get('votingEndsAt')) } });
      setDeadlineSaved('Saved. The voting countdown has been updated.');
      reload();
      refreshCompetition({ fresh: true });
    } catch (err) {
      setError(err);
    }
  }

  async function reopen(e) {
    e.preventDefault();
    setError(null);
    setDeadlineSaved(false);
    try {
      await api('/admin/phase/registration', { body: { endsAt: asIso(new FormData(e.currentTarget).get('reopenUntil')) } });
      setDeadlineSaved('Registration is open again, with the new countdown.');
      reload();
      onChange();
      refreshCompetition({ fresh: true });
    } catch (err) {
      setError(err);
    }
  }

  async function setVoting(status) {
    setError(null);
    try {
      await api(`/admin/voting/${status}`, { method: 'POST' });
      reload();
      onChange();
      refreshCompetition({ fresh: true });
    } catch (err) {
      setError(err);
    }
  }

  async function addPackage(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api('/admin/packages', { body: { votes: Number(f.get('votes')), price: Number(f.get('price')) } });
      form.reset();
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function addHistory(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api('/admin/results/history', { body: { competition: f.get('competition'), winner: f.get('winner'), date: f.get('date') } });
      form.reset();
      results.reload();
    } catch (err) {
      setError(err);
    }
  }

  if (!data) return <Loading />;
  const closed = data.votingStatus === 'closed';
  const registering = data.phase === 'registration';
  const waiting = data.pendingApplications;
  const deadlinePassed = Boolean(data.registrationEndsAt) && new Date(data.registrationEndsAt) <= new Date();

  return (
    <div className="admin-columns">
      <ErrorNote error={error} />
      <section className="panel">
        <h2>Contest stage</h2>
        {registering ? (
          <>
            {deadlinePassed
              ? <p><b>Applications have closed.</b> The deadline has passed. Voting starts when you press the button below, or set a later date to reopen applications.</p>
              : <p><b>Registration is open.</b> The home page promotes joining, and voting is off. {data.autoStartVoting && data.registrationEndsAt ? 'When the countdown ends, voting starts by itself and visitors are taken to the contestants.' : ''}</p>}
            <p className="muted">{num(data.approvedContestants)} approved · {num(waiting)} waiting for review</p>
            <form className="stage-deadline" onSubmit={saveDeadline}>
              <div className="inline-form">
                <Field label="Countdown ends (registration closes)" hint="Blank means no deadline. Applications stop at this time.">
                  <input key={data.registrationEndsAt} name="registrationEndsAt" type="datetime-local" defaultValue={toLocalInput(data.registrationEndsAt)} />
                </Field>
                <button className="btn btn-ghost">Save</button>
              </div>
              <label className="check-line">
                <input key={String(data.autoStartVoting)} type="checkbox" name="autoStart" defaultChecked={data.autoStartVoting} />
                Start voting automatically when the countdown ends
              </label>
            </form>
            {deadlineSaved ? <p className="note note-good">{deadlineSaved}</p> : null}
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={() => setAction({
                title: 'End registration and start voting',
                description: `New applications stop and voting opens for everyone straight away. ${num(data.approvedContestants)} approved contestants will be told by email.${waiting ? ` ${num(waiting)} applications are still waiting: you can still approve them afterwards.` : ''}`,
                confirm: 'Start voting',
                needsReason: false,
                run: () => api('/admin/phase/voting', { method: 'POST' }),
              })}
            >End registration and start voting</button>
          </>
        ) : (
          <>
            <p><b>Voting is on.</b> Registration has closed.</p>
            <form className="inline-form stage-deadline" onSubmit={saveVotingEnd}>
              <Field label="Voting countdown ends" hint="Voting stops by itself at this time. Blank means no end.">
                <input key={data.endsAt} name="votingEndsAt" type="datetime-local" defaultValue={toLocalInput(data.endsAt)} />
              </Field>
              <button className="btn btn-ghost">Save</button>
            </form>
            <form className="inline-form stage-deadline" onSubmit={reopen}>
              <Field label="Reopen registration until" hint="Voting stops and voting pages disappear. Votes already counted are kept.">
                <input name="reopenUntil" type="datetime-local" defaultValue={toLocalInput(new Date(Date.now() + 7 * 864e5).toISOString())} required />
              </Field>
              <button className="btn btn-ghost">Reopen registration</button>
            </form>
            {deadlineSaved ? <p className="note note-good">{deadlineSaved}</p> : null}
          </>
        )}
      </section>
      <JoiningPanels />
      <RoundsPanel voting={!registering} />
      <ThemesPanel />
      {registering ? null : (
      <section className="panel">
        <h2>Voting</h2>
        <p>Voting is currently <b>{data.votingStatus}</b>.</p>
        <div className="admin-actions">
          <button type="button" className="btn btn-primary btn-small" disabled={data.votingStatus === 'open'} onClick={() => setVoting('open')}>Open</button>
          <button type="button" className="btn btn-ghost btn-small" disabled={data.votingStatus === 'paused'} onClick={() => setVoting('paused')}>Pause</button>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={closed}
            onClick={() => setAction({
              title: 'Close voting',
              description: 'Supporters will no longer be able to vote.',
              confirm: 'Close voting',
              needsReason: false,
              run: () => api('/admin/voting/closed', { method: 'POST' }),
            })}
          >Close</button>
        </div>
        <h3>Final results</h3>
        {data.resultsPublishedAt ? <p className="muted">Published {dateTime(data.resultsPublishedAt)}. Reopening voting starts a new results round.</p> : (
          <>
            <p className="muted">{closed ? 'Publishing freezes the current standings on the Winners page.' : 'Close voting first.'}</p>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={!closed}
              onClick={() => setAction({
                title: 'Publish final results',
                description: 'The current standings go public on the Winners page and everyone is told who won.',
                confirm: 'Publish results',
                needsReason: false,
                run: () => api('/admin/results/publish', { method: 'POST' }),
              })}
            >Publish final results</button>
          </>
        )}
      </section>
      )}

      <section className="panel">
        <h2>Competition details</h2>
        <form className="stack" onSubmit={saveSettings}>
          <Field label="Competition name"><input name="name" defaultValue={data.name} required /></Field>
          <div className="form-grid">
            <Field label="Voting opens" hint="Blank means open now."><input name="startsAt" type="datetime-local" defaultValue={toLocalInput(data.startsAt)} /></Field>
            <Field label="Voting closes" hint="Drives the voting countdown. Voting stops by itself at this time."><input name="endsAt" type="datetime-local" defaultValue={toLocalInput(data.endsAt)} /></Field>
            <Field label="Price per vote (₦)" hint="The normal price, below the first bulk deal."><input name="votePrice" type="number" min="1" defaultValue={data.votePrice} required /></Field>
            <Field label="Flag single votes of at least" hint="0 turns this off."><input name="largeVoteThreshold" type="number" min="0" defaultValue={data.largeVoteThreshold} required /></Field>
          </div>
          {saved ? <p className="note note-good">Saved.</p> : null}
          <button className="btn btn-primary">Save details</button>
        </form>
      </section>

      <section className="panel">
        <h2>Bulk deals</h2>
        <p className="muted">From each deal’s number of votes upwards, every vote costs that deal’s rate. With 50 votes for {naira(8000)}, someone buying 70 votes pays {naira(160)} a vote. Every supporter is offered the next deal up before they pay.</p>
        {dealProblems(data.packages, data.votePrice).map((note) => <p key={note} className="note note-error">{note}</p>)}
        <div className="table-wrap">
          <table className="data-table packages-table">
            <thead><tr><th>Votes</th><th>Price (₦)</th><th className="num">Each</th><th>On sale</th></tr></thead>
            <tbody>{data.packages.map((p) => <PackageRow key={`${p.id}-${p.votes}-${p.price}`} pack={p} reload={reload} setError={setError} />)}</tbody>
          </table>
        </div>
        <form className="inline-form" onSubmit={addPackage}>
          <Field label="Votes"><input name="votes" type="number" min="1" required /></Field>
          <Field label="Price (₦)"><input name="price" type="number" min="1" required /></Field>
          <button className="btn btn-ghost">Add deal</button>
        </form>
      </section>

      <section className="panel">
        <h2>Competition history</h2>
        <ul className="history">
          {(results.data ?? []).map((r) => (
            <li key={r.id}>
              <span><b>{r.competition}</b><small>Winner: {r.standings[0]?.name} · {dateTime(r.publishedAt)}</small></span>
              <button
                type="button"
                className="text-link as-button"
                onClick={() => setAction({
                  title: 'Remove this record',
                  description: `Removes "${r.competition}" from the public Winners page.`,
                  confirm: 'Remove record',
                  needsReason: false,
                  run: () => api(`/admin/results/${r.id}`, { method: 'DELETE' }),
                })}
              >Remove</button>
            </li>
          ))}
        </ul>
        <form className="inline-form" onSubmit={addHistory}>
          <Field label="Past edition"><input name="competition" required placeholder="MBGN 2025" /></Field>
          <Field label="Winner"><input name="winner" required /></Field>
          <Field label="Date"><input name="date" type="date" required /></Field>
          <button className="btn btn-ghost">Add record</button>
        </form>
      </section>

      <ActionDialog
        action={action}
        onClose={() => setAction(null)}
        onDone={() => { setAction(null); reload(); results.reload(); onChange(); refreshCompetition({ fresh: true }); }}
      />
    </div>
  );
}

// What the sender (whatsapp-sender/) last reported, in plain words.
function senderStatus(data) {
  const s = data.sender;
  if (!data.configured) {
    return { tone: 'note-error', text: 'Not set up yet. Run scripts\\whatsapp-site.ps1 to connect Evolution API (see scripts/vps/README.md).' };
  }
  // Sent by this site through Evolution API, whose state is asked live.
  if (s?.direct) {
    if (s.state === 'connected') return { tone: 'note-good', text: 'Connected. Sending through Evolution API from the contest’s number, about 8 a minute.' };
    if (s.state === 'unreachable') return { tone: 'note-error', text: `Can’t reach Evolution API (${s.error}). Messages wait here until it’s back.` };
    return { tone: 'note-error', text: 'The contest phone isn’t connected. Open Evolution’s manager and reconnect it (scan the QR code). Messages wait here until then.' };
  }
  if (!s) return { tone: '', text: 'Set up on the site. Waiting for the sender to start for the first time.' };
  if (Date.now() - Date.parse(s.seenAt) > 2 * 60000) {
    return { tone: 'note-error', text: `The sender is offline. Last heard from ${dateTime(s.seenAt)}. Messages wait here until it is back.` };
  }
  if (s.state === 'connected') return { tone: 'note-good', text: `Sending from ${s.account ? `+${s.account}` : 'the contest’s number'}.` };
  if (s.state === 'waiting_for_scan') {
    return { tone: '', text: 'The sender is waiting to be linked. On the contest phone, open WhatsApp, go to Linked devices, and scan the QR code on the sender’s screen.' };
  }
  if (s.state === 'logged_out') return { tone: 'note-error', text: 'WhatsApp logged the sender out. It is showing a new QR code to scan.' };
  return { tone: '', text: 'The sender is connecting to WhatsApp…' };
}

const WHATSAPP_KINDS = { accepted: 'Acceptance', voting_open: 'Voting open' };

function WhatsAppPanel() {
  const { data, error: loadError, reload } = useFetch('/admin/whatsapp');
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);

  // The sender checks in every few seconds, so the status keeps itself current.
  useEffect(() => {
    const timer = setInterval(reload, 15000);
    return () => clearInterval(timer);
  }, [reload]);

  async function act(path, report) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setNote(report(await api(path, { method: 'POST' })));
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <section className="panel"><h2>WhatsApp messages</h2>{loadError ? <ErrorNote error={loadError} /> : <Loading />}</section>;
  }
  const status = senderStatus(data);
  return (
    <section className="panel whatsapp-panel">
      <h2>WhatsApp messages</h2>
      <p className="muted">Each accepted contestant gets their code, voting link and WhatsApp group link. When voting opens, each gets a ready-to-forward “vote for me” message.</p>
      <p className={`note ${status.tone}`} role="status">{status.text}</p>
      <dl className="wa-counts">
        <div><dt>Waiting to send</dt><dd>{num(data.waiting)}</dd></div>
        <div><dt>Sent</dt><dd>{num(data.sent)}</dd></div>
        <div><dt>Could not send</dt><dd>{num(data.failed)}</dd></div>
      </dl>
      <ErrorNote error={error} />
      {note ? <p className="note note-good">{note}</p> : null}
      {data.configured ? (
        <div className="wa-actions">
          {data.missingAccepted ? (
            <button type="button" className="btn btn-primary btn-small" disabled={busy}
              onClick={() => act('/admin/whatsapp/send-accepted', ({ queued }) => `Queued ${plural(queued, 'acceptance message')}.`)}>
              Message {plural(data.missingAccepted, 'accepted contestant')} who haven’t had one
            </button>
          ) : null}
          {data.failed ? (
            <button type="button" className="btn btn-ghost btn-small" disabled={busy}
              onClick={() => act('/admin/whatsapp/retry-failed', ({ retried }) => `Trying ${plural(retried, 'message')} again.`)}>
              Try the failed ones again
            </button>
          ) : null}
        </div>
      ) : null}
      {data.failures.length ? (
        <>
          <h3>Could not send</h3>
          <ul className="wa-failures">
            {data.failures.map((f) => (
              <li key={f.id}>
                <b>{f.contestant.name}</b> <span className="muted">{f.contestant.code} · +{f.to} · {WHATSAPP_KINDS[f.kind] ?? f.kind}</span>
                <small>{f.error}</small>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function MessagesTab() {
  const announcements = useFetch('/admin/announcements');
  const activity = useFetch('/admin/activity');
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  async function announce(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    setSent(null);
    try {
      const { recipients } = await api('/admin/announcements', { body: { title: f.get('title'), body: f.get('body'), public: f.get('public') === 'on' } });
      setSent(`Sent to ${num(recipients)} contestants.`);
      form.reset();
      announcements.reload();
      activity.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function postPublic(e) {
    e.preventDefault();
    const form = e.currentTarget;
    setError(null);
    try {
      await api('/admin/activity', { body: { message: new FormData(form).get('message') } });
      form.reset();
      activity.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function toggle(item) {
    await api(`/admin/activity/${item.id}/visibility`, { body: { hidden: !item.hidden } }).catch(setError);
    activity.reload();
  }

  return (
    <div className="admin-columns">
      <ErrorNote error={error} />
      <WhatsAppPanel />
      <section className="panel">
        <h2>Announcement to contestants</h2>
        <form className="stack" onSubmit={announce}>
          <Field label="Title"><input name="title" required /></Field>
          <Field label="Message"><textarea name="body" rows={4} required /></Field>
          <label className="check-line"><input type="checkbox" name="public" /> Also show it in the public activity feed</label>
          {sent ? <p className="note note-good">{sent}</p> : null}
          <button className="btn btn-primary">Send to all approved contestants</button>
        </form>
        <h3>Sent</h3>
        {!announcements.data?.length ? <p className="muted">Nothing sent yet.</p> : (
          <ul className="history">
            {announcements.data.map((a) => <li key={a.id}><span><b>{a.title}</b><small>{a.body}</small></span><small>{dateTime(a.created_at)}</small></li>)}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Public notifications</h2>
        <form className="inline-form" onSubmit={postPublic}>
          <Field label="Post to the public feed"><input name="message" required maxLength={200} /></Field>
          <button className="btn btn-ghost">Post</button>
        </form>
        {!activity.data ? <Loading /> : (
          <ul className="history">
            {activity.data.map((a) => (
              <li key={a.id} className={a.hidden ? 'is-hidden' : ''}>
                <span>{a.message}<small>{dateTime(a.createdAt)}{a.hidden ? ' · hidden' : ''}</small></span>
                <button type="button" className="text-link as-button" onClick={() => toggle(a)}>{a.hidden ? 'Show' : 'Hide'}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AccountTab() {
  const { user, setUser } = useApp();
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    setSaved(null);
    if (f.get('newPassword') !== f.get('confirmPassword')) {
      setError(new Error('The two new passwords do not match.'));
      return;
    }
    setBusy(true);
    try {
      const { email } = await api('/admin/account', {
        method: 'PUT',
        body: { email: f.get('email'), newPassword: f.get('newPassword'), currentPassword: f.get('currentPassword') },
      });
      setUser({ ...user, email });
      setSaved(f.get('newPassword') ? 'Saved. Use the new password next time. Other browsers signed in as you have been signed out.' : 'Saved.');
      form.querySelector('[name=newPassword]').value = '';
      form.querySelector('[name=confirmPassword]').value = '';
      form.querySelector('[name=currentPassword]').value = '';
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-columns">
      <section className="panel">
        <h2>Your login</h2>
        <p className="muted">The email and password you use to open this control panel. Anyone with them can change votes, prices and the contest, so choose a password nobody could guess.</p>
        <form className="stack" onSubmit={save}>
          <Field label="Email address"><input name="email" type="email" autoComplete="username" defaultValue={user?.email ?? ''} required /></Field>
          <div className="form-grid">
            <Field label="New password" hint="Leave blank to keep your password. At least 8 characters."><input name="newPassword" type="password" autoComplete="new-password" minLength={8} /></Field>
            <Field label="New password again"><input name="confirmPassword" type="password" autoComplete="new-password" /></Field>
          </div>
          <Field label="Current password" hint="Needed to save any change."><input name="currentPassword" type="password" autoComplete="current-password" required /></Field>
          <ErrorNote error={error} />
          {saved ? <p className="note note-good">{saved}</p> : null}
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </form>
      </section>
    </div>
  );
}

function ReportsTab() {
  const outbox = useFetch('/admin/outbox');
  const audit = useFetch('/admin/audit');
  return (
    <div className="admin-columns">
      <section className="panel">
        <h2>Export reports</h2>
        <div className="share-row">
          <a className="btn btn-ghost" href="/api/admin/export/contestants.csv">Contestants (CSV)</a>
          <a className="btn btn-ghost" href="/api/admin/export/votes.csv">Votes (CSV)</a>
          <a className="btn btn-ghost" href="/api/admin/export/payments.csv">Payments (CSV)</a>
        </div>
      </section>
      <section className="panel">
        <h2>Email log</h2>
        {!outbox.data?.length ? <p className="muted">No emails yet.</p> : (
          <ul className="history">
            {outbox.data.map((m) => <li key={m.id}><span><b>{m.subject}</b><small>{m.to_addr} · {dateTime(m.created_at)}</small></span><em className="tag">{m.status}</em></li>)}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Admin activity</h2>
        {!audit.data?.length ? <p className="muted">No admin actions yet.</p> : (
          <ul className="history">
            {audit.data.map((a, i) => <li key={i}><span><b>{a.action}</b><small>{a.details}</small></span><small>{dateTime(a.created_at)}</small></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
