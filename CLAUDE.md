# Ligatures

A personal CRM on top of Google Contacts. Contacts sync two ways with Google; extra fields (“your fields”), lists, relationships, pins, drafts and other Ligatures-only data live in Ligatures and never sync back to Google, iPhone or Mac.

Two apps share one backend:

- **Web app**: Cloudflare Pages + Functions + D1. Every push to `main` auto-deploys.
- **iOS app**: native SwiftUI, built on GitHub’s Macs and shipped to TestFlight. Intended to replace the iOS Contacts app.

Repo: `samrgray/ligature` (public, so no secrets in code or history).

The app is called **Ligatures** in everything people see. Internal names stay `ligature` on purpose: the bundle ID `com.samrgray.ligature`, the `ligature://auth` sign-in link, the Cloudflare project (`ligature-50o.pages.dev`), the D1 database, browser storage keys, and the Swift target and folder names. Renaming those would break sign-in or make App Store Connect treat it as a new app.

## Layout

```
functions/api/      HTTP routes (Pages Functions): auth, contacts, fields, lists, map, messages,
                    pins, relationships, archive, backup, prefs, sync, session
lib/                server code: schema.ts (D1 tables), session, sync engine, crypto, geo, email
lib/providers/      contacts backends behind one interface (google.ts today)
public/             web front end, no build step: app.js, app.css, map.js, messaging.js,
                    relations.js, theme.js, vendor/
ios/                SwiftUI app; project.yml (XcodeGen), Ligature/, LigatureUITests/
scripts/            mock-google.mjs (fake OAuth + People API), make-test-contacts.py
.github/workflows/  ios.yml
```

## Architecture rules

- **Google People API**, server-side OAuth (authorization code flow, PKCE, refresh tokens), contacts scope only.
- Each contact’s Ligatures data is keyed to Google’s contact ID, and Ligatures’s own ID is also stamped into the contact’s `clientData` so links survive merges.
- **Send the etag on every write.** Never overwrite a newer change in Google. There is deliberately no read-only switch: two-way sync is the point of the app.
- **Providers:** Google is one provider among future ones (CardDAV, iCloud). Don’t write Google-specific logic outside `lib/providers/`.
- **Every record belongs to a user.** The app must keep working self-hosted (`ALLOW_SIGNUPS` in `wrangler.toml`).
- **Schema** lives in `lib/schema.ts` (`CREATE TABLE IF NOT EXISTS …` plus migrations). The JSON backup (`functions/api/backup.ts`) picks up new tables automatically; keep it that way.
- **Drafts** are contacts kept only in Ligatures until promoted to Google. They mirror all fields.
- **List-specific fields** only apply to people in that list, and show as columns only while viewing that list.

## Data safety

The connected Google account now holds **real people and real Ligatures-only data**. Don’t lose either.

- Test against the mock server (`npm run dev:mock`, see `.dev.vars.example`) or iOS demo data, never against the live account.
- Any schema change must migrate existing rows, not drop or recreate tables.
- Anything that deletes or rewrites contacts in bulk needs Sam’s explicit go-ahead.

## Workflow

- **Web:** run locally with `npm run dev` against the mock Google server; test with Playwright; `npm run typecheck`; push to `main`; confirm the “Cloudflare Pages” check run succeeds on the commit.
- **iOS:** pushes to `main` touching `ios/**` build, sign and upload to TestFlight (secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, `APPLE_TEAM_ID` are set in the repo). Simulator screenshots and XCUITests (demo data, no sign-in) run only via `workflow_dispatch` with `-f 'inputs[screenshots]=true'`; results land on the `ci-output` branch, the TestFlight build log on `ci-testflight`. Mac minutes are limited, so batch iOS changes.
- **Get iOS changes to TestFlight fast.** Sam wants to try changes on his phone as soon as possible. Push iOS changes straight to `main` (TestFlight takes about 4 minutes, plus Apple’s processing); don’t hold them back for a simulator run first. When a change is worth UI tests or screenshots, run them at the same time on a separate branch (push the same commit to a branch, then dispatch the workflow there with screenshots on and TestFlight off). Never dispatch on `main`: it shares the push run’s concurrency group and would cancel the TestFlight build. If a test fails, fix it in the next build.
- Minimum iOS is 18. SwiftUI drag gestures inside scroll views block scrolling on iOS 18+; use UIKit recognizers (see `HoldToDrag`) instead.
- Gestures, swiping and feel can only be judged on a real phone. Say so when handing back iOS work.
- Keep web and iOS in step: most features ship on both.

## Parallel sessions

Several sessions may work on this repo at once. Each should:

- Work on its own branch and open a PR, or rebase on `main` right before pushing.
- Stay within one area (e.g. web UI in `public/`, server in `functions/` + `lib/`, iOS in `ios/`) to avoid conflicts. `public/app.js` and `ios/Ligature/Views/ContactsListView.swift` are large and touched often; avoid two sessions editing either at once.
- Not push two iOS changes to `main` back to back; the workflow cancels the earlier run.

## Sam’s preferences

- Gives short, high-level requests and expects implementation, tests and shipping without much back-and-forth; gives direct corrections when something’s off.
- Clean, simple, functional design; direct, unsentimental copy.
- Curly quotes and apostrophes (’ “ ”) in all user-facing text.
- `-webkit-font-smoothing: antialiased` and `-moz-osx-font-smoothing: grayscale` on `body`.
- To dim or fade something, shift its color toward the background; don’t use transparency.
- Current look (web and iOS): warm paper, subtle grain, raised chips, frosted panels.
- When reporting back: what changed, where it’s live (web / TestFlight build number), and what needs checking on a real device. No step-by-step recaps.

## Decided against

- Read-only mode.
- Manual “last talked” / “last message” tracking.
- Gmail / iMessage / Calendar interaction history (for now).
- Syncing Ligatures lists to Apple Contacts.
- Swiping between contact cards in the iOS list (replaced by the table layout).

## Ideas, not yet decided

- Possibly public someday, likely self-hosted only rather than app stores.
- Support providers beyond Google (CardDAV, iCloud).
