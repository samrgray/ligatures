import type { AccountRow, ContactRow, Data, Env, Group } from '../../lib/types';
import { HttpError, json, readJson } from '../../lib/http';
import { requireUser } from '../../lib/session';
import { provider } from '../../lib/providers';
import { refreshContacts, setDraftMembership } from '../../lib/contacts';

const MAX_MEMBERS = 1000;

/**
 * Nesting, colors and emoji live only in Ligature (in your settings). A deleted list’s
 * sublists move up a level, and its color and emoji go.
 */
async function forgetList(db: D1Database, userId: string, accountId: string, listId: string) {
  const row = await db.prepare('SELECT prefs FROM users WHERE id = ?1').bind(userId).first<{ prefs: string | null }>();
  type Ref = { accountId: string; id: string };
  let prefs: { listParents?: (Ref & { parentId: string })[]; listStyles?: Ref[] } & Record<string, unknown>;
  try {
    prefs = JSON.parse(row?.prefs || '{}') ?? {};
  } catch {
    return;
  }
  const parents = Array.isArray(prefs.listParents) ? prefs.listParents : [];
  const styles = Array.isArray(prefs.listStyles) ? prefs.listStyles : [];
  const mine = (x: Ref) => x.accountId === accountId && x.id === listId;
  const nested = parents.some((x) => x.accountId === accountId && (x.parentId === listId || x.id === listId));
  if (!nested && !styles.some(mine)) return;
  const up = parents.find(mine)?.parentId;
  prefs.listParents = parents
    .filter((x) => !mine(x))
    .flatMap((x) => (x.accountId === accountId && x.parentId === listId ? (up ? [{ ...x, parentId: up }] : []) : [x]));
  if (styles.length) prefs.listStyles = styles.filter((x) => !mine(x));
  await db.prepare('UPDATE users SET prefs = ?2 WHERE id = ?1').bind(userId, JSON.stringify(prefs)).run();
}

// POST /api/lists — manage lists (Google calls them labels). Changes go straight to Google.
//   { action: 'create', accountId, name }
//   { action: 'rename', accountId, groupId, name }
//   { action: 'delete', accountId, groupId }            → the list goes; its contacts stay
//   { action: 'members', accountId, groupId, add?, remove? }   (Ligature contact IDs)
// Returns the account’s lists, plus the lists and etag of every contact that changed.
export const onRequestPost: PagesFunction<Env, string, Data> = async ({ request, env, data }) => {
  const user = requireUser(data.user);
  const body = await readJson<{ action?: unknown; accountId?: unknown; groupId?: unknown; name?: unknown; add?: unknown; remove?: unknown }>(request);
  const account = await env.DB
    .prepare('SELECT * FROM accounts WHERE id = ?1 AND user_id = ?2')
    .bind(String(body.accountId ?? ''), user.id)
    .first<AccountRow>();
  if (!account) throw new HttpError(404, 'Account not found.');
  const p = provider(account.provider);
  const ctx = { env, db: env.DB, account };
  let groups = JSON.parse(account.groups_json ?? '[]') as Group[];

  const findGroup = () => {
    const g = groups.find((x) => x.id === body.groupId);
    if (!g) throw new HttpError(404, 'That list isn’t in this account. Sync and try again.');
    return g;
  };
  const readName = () => {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw new HttpError(400, 'Give the list a name.');
    if (name.length > 100) throw new HttpError(400, 'List names can be up to 100 characters.');
    return name;
  };
  const ownRows = async (ids: string[]) =>
    ids.length
      ? (
          await env.DB
            .prepare(
              `SELECT * FROM contacts WHERE user_id = ?1 AND account_id = ?2 AND deleted_at IS NULL AND merged_into IS NULL AND archived_at IS NULL
                 AND id IN (SELECT value FROM json_each(?3))`,
            )
            .bind(user.id, account.id, JSON.stringify(ids))
            .all<ContactRow>()
        ).results
      : [];

  let changed: ContactRow[] = [];
  let skipped = 0;
  let group: Group | undefined;

  switch (body.action) {
    case 'create': {
      group = await p.createGroup(ctx, readName());
      groups = [...groups.filter((g) => g.id !== group!.id), group];
      break;
    }
    case 'rename': {
      const g = findGroup();
      if (g.system) throw new HttpError(400, `${g.name} is built into Google and can’t be renamed.`);
      group = await p.renameGroup(ctx, g.id, readName());
      groups = groups.map((x) => (x.id === g.id ? group! : x));
      await env.DB.prepare('UPDATE field_defs SET list_name = ?1 WHERE user_id = ?2 AND account_id = ?3 AND list_id = ?4')
        .bind(group.name, user.id, account.id, g.id)
        .run();
      break;
    }
    case 'delete': {
      const g = findGroup();
      if (g.system) throw new HttpError(400, `${g.name} is built into Google and can’t be deleted.`);
      const members = await p.deleteGroup(ctx, g.id);
      groups = groups.filter((x) => x.id !== g.id);
      const rows = members.length
        ? (
            await env.DB
              .prepare(
                `SELECT * FROM contacts WHERE account_id = ?1 AND deleted_at IS NULL AND merged_into IS NULL AND archived_at IS NULL
                   AND provider_contact_id IN (SELECT value FROM json_each(?2))`,
              )
              .bind(account.id, JSON.stringify(members))
              .all<ContactRow>()
          ).results
        : [];
      const drafts = (
        await env.DB
          .prepare(
            `SELECT * FROM contacts WHERE account_id = ?1 AND draft = 1 AND deleted_at IS NULL AND merged_into IS NULL AND instr(data_json, ?2) > 0`,
          )
          .bind(account.id, `"${g.id}"`)
          .all<ContactRow>()
      ).results;
      changed = [...(await refreshContacts(env, account, rows)), ...(await setDraftMembership(env.DB, drafts, g.id, false, account.provider))];
      await forgetList(env.DB, user.id, account.id, g.id);
      break;
    }
    case 'members': {
      const g = findGroup();
      const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      const add = ids(body.add);
      const remove = ids(body.remove);
      if (!add.length && !remove.length) throw new HttpError(400, 'Choose contacts to add or remove.');
      if (add.length > MAX_MEMBERS || remove.length > MAX_MEMBERS) throw new HttpError(400, `Up to ${MAX_MEMBERS} contacts at a time.`);
      const addRows = await ownRows(add);
      const removeRows = await ownRows(remove);
      skipped = add.length + remove.length - addRows.length - removeRows.length;
      const real = (rows: ContactRow[]) => rows.filter((r) => !r.draft);
      if (real(addRows).length || real(removeRows).length) {
        await p.modifyGroup(
          ctx,
          g.id,
          real(addRows).map((r) => r.provider_contact_id),
          real(removeRows).map((r) => r.provider_contact_id),
        );
      }
      changed = [
        ...(await refreshContacts(env, account, [...real(addRows), ...real(removeRows)])),
        // Drafts aren’t in Google: their lists change here.
        ...(await setDraftMembership(env.DB, addRows.filter((r) => r.draft), g.id, true, account.provider)),
        ...(await setDraftMembership(env.DB, removeRows.filter((r) => r.draft), g.id, false, account.provider)),
      ];
      group = g;
      break;
    }
    default:
      throw new HttpError(400, 'Unknown list action.');
  }

  await env.DB.prepare('UPDATE accounts SET groups_json = ?2 WHERE id = ?1').bind(account.id, JSON.stringify(sortLists(groups))).run();
  return json({
    group,
    groups: sortLists(groups),
    contacts: changed.map((r) => {
      const card = p.toCard(JSON.parse(r.data_json ?? '{}'));
      return { id: r.id, etag: r.etag, groups: card.groups };
    }),
    skipped,
  });
};

function sortLists(groups: Group[]): Group[] {
  const starred = (g: Group) => (g.id === 'contactGroups/starred' ? 0 : 1);
  return [...groups].sort((a, b) => starred(a) - starred(b) || a.name.localeCompare(b.name));
}
