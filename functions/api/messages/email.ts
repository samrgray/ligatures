import type { AccountRow, Data, Env } from '../../../lib/types';
import { HttpError, json, readJson } from '../../../lib/http';
import { requireUser } from '../../../lib/session';
import { canSendEmail, sendGmail } from '../../../lib/providers/google';
import { buildEmail, isEmail, type Address } from '../../../lib/email';
import { ownedContacts } from '../../../lib/contacts';

const MAX_GROUP = 100;

interface Body {
  accountId?: unknown;
  mode?: unknown;
  groupTo?: unknown;
  recipients?: unknown;
  subject?: unknown;
  body?: unknown;
}

// POST /api/messages/email
// One email per call: individually, one recipient; as a group, everyone on one message.
// The browser sends individual emails one at a time, which keeps each call well inside
// Cloudflare’s per-request limits and lets you watch progress.
export const onRequestPost: PagesFunction<Env, string, Data> = async ({ request, env, data }) => {
  const user = requireUser(data.user);
  const b = await readJson<Body>(request);

  const account = await env.DB
    .prepare('SELECT * FROM accounts WHERE id = ?1 AND user_id = ?2')
    .bind(typeof b.accountId === 'string' ? b.accountId : '', user.id)
    .first<AccountRow>();
  if (!account) throw new HttpError(400, 'Choose the Google account to send from.');
  if (account.provider !== 'google' || !canSendEmail(account)) {
    throw new HttpError(403, 'Ligatures doesn’t have permission to send email from this account yet. Connect Gmail and try again.', 'gmail_scope');
  }

  const mode = b.mode === 'group' ? 'group' : 'individual';
  const subject = typeof b.subject === 'string' ? b.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 300) : '';
  const body = typeof b.body === 'string' ? b.body.slice(0, 50000) : '';
  if (!subject) throw new HttpError(400, 'Add a subject.');
  if (!body.trim()) throw new HttpError(400, 'Write a message.');

  if (!Array.isArray(b.recipients)) throw new HttpError(400, 'No recipients.');
  const recipients = (b.recipients as { contactId?: unknown; email?: unknown; name?: unknown }[]).map((r) => ({
    contactId: typeof r?.contactId === 'string' ? r.contactId : '',
    email: typeof r?.email === 'string' ? r.email.trim() : '',
    name: typeof r?.name === 'string' ? r.name.slice(0, 200) : '',
  }));
  if (!recipients.length) throw new HttpError(400, 'No recipients.');
  if (mode === 'individual' && recipients.length !== 1) throw new HttpError(400, 'Individual emails go to one person each.');
  if (recipients.length > MAX_GROUP) throw new HttpError(400, `Gmail takes at most ${MAX_GROUP} people on one email. Split the list.`);
  for (const r of recipients) if (!isEmail(r.email)) throw new HttpError(400, `“${r.email || 'blank'}” isn’t an email address.`);

  const contacts = await ownedContacts(env.DB, user, recipients.map((r) => r.contactId));

  // One copy per address, even if two contacts share it.
  const seen = new Set<string>();
  const addresses: Address[] = [];
  for (const r of recipients) {
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ name: r.name, email: r.email });
  }
  const bcc = mode === 'group' && b.groupTo !== 'to';
  const raw = buildEmail({ to: bcc ? [] : addresses, bcc: bcc ? addresses : [], subject, body });

  const sent = await sendGmail({ env, db: env.DB, account }, raw);

  return json({ ok: true, messageId: sent.id, sent: contacts.length });
};
