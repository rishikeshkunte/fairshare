# FairShare

Shared expenses made simple and fair. FairShare is a single-page expense splitter that runs in the browser. You can use it with no account. Sign in with Google to sync shared groups and friend ledgers across connected accounts.

## Run it

Serve the folder over HTTP. A service worker and the Google scripts expect a real origin, so opening `index.html` as a file is unreliable.

```bash
python -m http.server 8765
```

Then open `http://127.0.0.1:8765/`.

The app is a progressive web app. `manifest.json` supplies the name and icon. `sw.js` caches `index.html`, `fairshare.css`, the logo, and the manifest (`fairshare-v20`) so a later visit can load without a network. Firebase, Google fonts, and the receipt reader still need a connection the first time they are used.

## Files

| File | Role |
| --- | --- |
| `index.html` | The whole app: markup, navigation, ledger math, storage, and Firebase |
| `fairshare.css` | Layout, theme, and motion |
| `sw.js` | Offline cache |
| `manifest.json` | Installable app metadata |
| `fairshare_logo.jpg` | Icon |
| `js/` | Money, dialogs, receipt compression, and the lazy Firebase loader |
| `firestore.rules`, `storage.rules` | Access rules for groups, friend requests, and receipt files |

## Screens

The desktop sidebar and the phone tab bar both call `navigateTo(pageId)`, which shows one `.app-page`, updates the hash, and scrolls to the top.

- **Home.** Overall standing across shared groups and friend ledgers, shortcuts to add an expense, review balances, or settle up, and live previews of debts, the ledger, category mix, and people.
- **Add expense.** Amount, presets, group or 1-on-1 scope, payer, date, notes, optional receipt, and the split.
- **Balances.** Total spend, expense count, settlement count, simplify toggle, who pays whom, the member sheet, and separate 1-on-1 balances.
- **History.** Group and 1-on-1 rows, grouped by date, with search, type filters, and a member filter. Open a row to edit or delete it.
- **Analytics.** By category, who spent what (paid vs share), and a 6-month trend, with Active group, All groups, and 1-on-1 scopes.
- **Friends.** Group name, currency, and members. Google account, incoming requests, email or WhatsApp invites, and the friend roster on the right.

On a phone the six destinations sit in the bottom bar. On a desktop a scroll pill at the bottom shows the current page and can jump to any of them.

## Adding an expense

1. Choose **Group expense** or **1-on-1 with a friend**.
2. Enter an amount and a description. Presets fill the description, pick a category, and focus the amount.
3. The description is matched against a keyword list (dinner, uber, grocery, movie, wifi, and similar words). A match sets the category and shows **Auto**. Changing the category yourself shows **Manual** and stops further guessing.
4. Pick who paid, the date, and optional notes.
5. Choose a split and save.

A receipt photo is optional. Drop or browse an image. The file stays in the expense as a data URL, and [Tesseract.js](https://github.com/naptha/tesseract.js) tries to read a total from the image into the amount field. You can clear the photo before saving.

### Split methods

Shares are computed in `computeSplitShares` and must add up to the amount.

| Method | Rule |
| --- | --- |
| Equally | The amount is divided across the people whose boxes are checked |
| Exact amounts | The typed amounts must match the total within 5 paise |
| Percentages | The percents must add up to 100 within half a percent |
| Shares / ratio | Each person gets `amount × their weight / sum of weights` |

Group expenses are stored on the active group. 1-on-1 expenses are stored in `directTransactions` and do not change the group balance sheet. They do appear in History, Analytics, the home feed, and the Direct 1-on-1 list. A 1-on-1 bill with a Google friend also syncs to that friend's account. A local name or mobile number does not.

## How balances work

For each group member, start at zero and walk the group's transactions:

- **Expense.** Add the full amount to the payer (they covered it). Subtract each person's share. A positive result means the group owes that person. A negative result means they owe the group.
- **Settlement.** Add the amount to the person who paid, and subtract it from the person who received it. Settlements are not counted in total spend.

**Simplify debts** is on by default. On, FairShare collapses the net balances into the fewest payments (if A owes B and B owes C, A can pay C). Off, it lists each pair from the raw expenses and settlements without routing money through a third person. Either way, a **Settle** button records a settlement for that suggested amount. **Custom settlement** records any payment you type.

The home standing aggregates balances across groups and direct 1-on-1 ledgers. Group and direct friend balances are also available in the balance details.

Changing the currency symbol does not convert existing numbers. A dinner of 900 stays 900 if you switch from ₹ to $.

## History and charts

History searches description, payer, category, and notes, and highlights the match. **Clear all** wipes the active group's transactions and the 1-on-1 list after a confirmation. It does not delete groups or friends.

Analytics can show spending by category, paid-vs-share by person, or a 6-month monthly trend. Choose the scope first: Active group, All groups in the active currency, or 1-on-1 bills.

## Groups and friends

A new account starts with no groups and no friends. The active group is the one selected in the sidebar. Its id is unique. Group discovery is based on the signed-in Google email being present in `memberEmails`. The old shared id `group_default` is renamed the first time a signed-in user syncs, so two people do not accidentally write the same cloud document. An untouched seeded **My Group** with no expenses is removed on load.

- **New group** asks for a name, a currency, and which friends to include. `You` is always a member. The last group can be deleted.
- **Google friends** are the ones who sync. Adding one to a group writes their email onto the group. When they are signed in, FairShare loads every group whose member list contains their email, and they see the same expenses.
- **Local friends** and **mobile numbers** stay on this device. They are labeled that way in the roster, the group picker, and the 1-on-1 split. A mobile number is shown as the name until you rename it. The web app does not read phone contacts.
- **1-on-1 bills with a Google friend** are stored in a shared ledger for that pair of emails. Local and phone 1-on-1 bills never leave the device.
- **In-app request** needs both people to be signed in. It writes a `friend_requests` document addressed to the other person's Google email. They approve or decline on Friends. **Open in Gmail** and **Share via WhatsApp** only open those apps with a prefilled message.

Direct 1-on-1 balances are the net of bills and settlements with one saved friend, outside any group.

## What is saved

`localStorage` key `fairshare_state_v9`. Older keys `v6` through `v8` are read once if `v9` is missing.

```text
theme                  light or dark
activeGroupId
friends[]              { id, name, email?, phone?, approved?, type? }
directTransactions[]   1-on-1 expenses and settlements. Google ones also store friendEmail
groups[id]
  name, currency, members[], simplifyDebts
  transactions[]
```

An expense looks like this:

```text
id, type: "expense", scope, friend, desc, amount, payer,
category, shares, splitMode, date, dateISO, notes,
timestamp, receipt
```

A settlement uses `type: "settlement"` plus `payer`, `receiver`, and `amount`.

The person using the app on this browser is the member named `You`. Signing in does not rename that member inside groups you already have.

## Google sign-in

Sign-in is optional. The Firebase web config lives in `index.html` for the `fairshare-app-ba160` project. When you are signed in:

- Each of your groups is written to Firestore at `groups/{groupId}` with `memberEmails` and `memberLinks`. On that copy, `You` is stored as your Google name.
- A listener loads every group whose `memberEmails` contains your email, and every 1-on-1 ledger in `direct_ledgers` whose `participants` contains your email. Applying a snapshot does not immediately write it back.
- Friend requests are queried by your Google email.

If Firebase cannot load, or the popup is blocked, the app stays fully usable offline. The domain you host on must be listed under Firebase Authentication authorized domains, or Google will refuse the popup.

## Interface notes

Light and dark themes are stored in the same state object. The first visit with no saved state follows the operating system.

Some motion is adapted from [Rare UI](https://www.rareui.com/components): the phone tab bar, the rolling balance figures, the scroll jumper, the confirm-to-delete control, and the request bell.

## GitHub Pages

This folder is the site root. It includes `.nojekyll` so `js/` is served as written. In the repository, open **Settings → Pages**, choose the branch, and set the folder to **`/ (root)`**. The public site is [https://rishikeshkunte.github.io/fairshare/](https://rishikeshkunte.github.io/fairshare/).

## Firebase setup

Sign-in is optional. The web config is in `index.html` and is loaded only when someone signs in, or when this browser has already chosen Google sync.

1. Enable **Authentication → Google** and **Cloud Firestore** and **Storage** on the Firebase project.
2. Deploy the rules in this repo:

```bash
npx firebase-tools deploy --only firestore:rules,storage --project fairshare-app-ba160
```

3. In **Firebase Console → Authentication → Settings → Authorized domains**, add `rishikeshkunte.github.io` and `localhost`.
4. The API key is visible in the page. In **Google Cloud Console → APIs & Services → Credentials**, restrict that key by HTTP referrer to `https://rishikeshkunte.github.io/*`, `http://localhost:*`, and `http://127.0.0.1:*`.

Groups can be read only by emails listed in `memberEmails`. Friend requests can be read by the sender or the recipient. Receipt images live in Storage; Firestore group documents keep the URL, not the photo bytes. Money is stored as integer paise after the one-time migration from older rupee amounts.
