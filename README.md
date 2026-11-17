# The Hurdle (Online)

A two-player Wordle variant. One player sets a word, the other guesses, then roles swap.

- **GitHub Pages** hosts the game (free).
- **Firebase Realtime Database** syncs the two players live (free).
- **Supabase (Postgres/SQL)** stores the word lists and checks words (free).

## 1. Firebase: live game sync (about 5 minutes)

1. Go to https://console.firebase.google.com and click **Add project** (skip Analytics).
2. **Build > Realtime Database > Create Database**, any location, **locked mode**.
3. Open the **Rules** tab, paste this, and click **Publish**:

```json
{
  "rules": {
    "lobby": { ".read": true, ".write": true },
    "rooms": { "$room": { ".read": true, ".write": true } }
  }
}
```

4. Gear icon > **Project settings** > **Your apps** > the **</>** web icon. Register an app (no hosting).
5. Copy the config values into `firebase-config.js`. `databaseURL` must match the URL on the Realtime Database page.

## 2. Supabase: the SQL word database (about 5 minutes)

1. Go to https://supabase.com, sign in, and click **New project** (free plan, choose any region and password).
2. Open **SQL Editor > New query**, paste all of `schema.sql`, and click **Run**. This creates the `words` table and two functions, `is_valid_guess` and `is_valid_answer`.
3. New query again, paste all of `seed.sql`, and click **Run**. This loads 12,972 valid words, 2,315 of which can be picked as secret words. (The file is about 90 KB; if the editor is slow, wait a few seconds.)
4. Check it worked: run `select count(*), count(*) filter (where is_answer) from words;` and expect `12972` and `2315`.
5. Go to **Project settings > API** and copy the **Project URL** and the **anon** (or **publishable**) key into `supabase-config.js`. Never use the secret or service_role key.

The table is locked with Row Level Security, so the public key cannot read it. The browser can only ask yes/no questions through the two functions, which means the word list is not downloadable from the page.

## 3. Put it on GitHub Pages

1. Create a public GitHub repository.
2. Upload `index.html`, `game.js`, `firebase-config.js`, `supabase-config.js`, and `README.md`. (`schema.sql` and `seed.sql` are optional to upload; they are only needed once, in Supabase.)
3. **Settings > Pages**: *Deploy from a branch*, `main`, `/ (root)`, save.
4. After a minute the game is live at `https://YOUR_NAME.github.io/YOUR_REPO/`.

## Testing locally

Browsers block ES modules from `file://`, so run a small server in the folder:

    python -m http.server 8000

Open http://localhost:8000 in two tabs (each tab is its own player).

## Managing the word list

Everything is plain SQL in the Supabase SQL Editor:

    insert into words (word, is_answer) values ('pixel', true) on conflict (word) do update set is_answer = true;
    update words set is_answer = false where word = 'obscure';   -- keep it guessable, never the secret
    delete from words where word = 'badword';

Changes apply instantly; no redeploy needed.

## Known limits

- **Supabase free projects pause after about a week of no activity.** If word checks start failing, open the Supabase dashboard and click **Restore project**. Regular play keeps it awake.
- The secret word is stored in the Firebase room so both screens can color guesses; a guesser using developer tools could peek. Fine for friends.
- Old Firebase rooms are not deleted automatically. You can clear `rooms` in the Firebase console now and then.
- If a player closes their tab, they can only rejoin from the same tab session; a brand new browser sees the room as full.
