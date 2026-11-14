# Watch Match ♥

A private, Tinder-style swiper for movies and TV shows — just for two.
Swipe right (♥), left (✕) or up (★ must watch). When you both like something, it's a match.

## How it works
- Open the site, tap **Create our room**, pick your profile (A or B), then send the room link from the **Us** tab to your partner. They open it and pick the other profile.
- Swipes sync live through a free Firebase Realtime Database (`config.js`). Without a config the app runs in local demo mode.
- The room code is the only key to your data, so keep the link between the two of you.
- Catalog: ~700 popular movies (Wikidata + Wikipedia) and ~700 shows (TVmaze), baked into `data/catalog.json`. Refresh it with `node scripts/build-catalog.mjs`.

## Firebase setup
1. console.firebase.google.com → Add project (Analytics off is fine).
2. Build → Realtime Database → Create database → start in **locked mode**.
3. Rules tab → paste `database.rules.json` → Publish.
4. Project settings → Your apps → Web (`</>`) → register → copy the `firebaseConfig` object into `config.js`.
