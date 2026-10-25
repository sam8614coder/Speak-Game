# SPEAK Online

Play SPEAK with friends over the internet, with a built-in voice phone call:
an **open table** everyone hears, plus **private lines** (call one player to plot an alliance).

## Run it on your own computer (testing, or friends on the same Wi-Fi)
    npm install
    npm start          # http://localhost:3000
Friends on the same network open `http://<your-PC-IP>:3000`.
NOTE: browsers only allow the microphone on **https** or **localhost**, so for real remote play use one of the options below.

## Play with friends anywhere (pick one)
**A. Render.com (free, easiest)**: push this folder to a GitHub repo, then Render > New > Web Service > pick the repo
(it reads `render.yaml`). You get an `https://something.onrender.com` link. Send it to friends. (Free instances sleep when idle; the first load takes ~30s.)

**B. Railway / Fly.io / any Docker host**: a `Dockerfile` and `Procfile` are included. Set nothing; the app uses `$PORT`.

**C. Quick tunnel from your PC (no account)**: run `npm start`, then in another terminal
`npx cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`). Share the https link it prints while your PC is on.

## How a game goes
1. One person taps **Create room**, shares the 4-letter code or invite link.
2. Everyone taps **Pick up the phone** (allow the microphone). Use headphones.
3. Host starts. Each round: **Talk** (voice) > **Plan** (secret orders on your own screen) > **Reveal**.
4. To scheme: open **Phones**, tap **Call privately** on a player. When they answer you are both on a private line and no longer hear the open table. **Back to open table** rejoins everyone.

## Voice notes
* Voice is peer-to-peer (WebRTC), audio never goes through the server. Works for up to 6 players.
* Some strict networks (company/school Wi-Fi, some mobile carriers) block direct connections. Add a TURN relay:
  set env `TURN_URL=turn:your.host:3478` (comma-separate several), `TURN_USER`, `TURN_PASS`
  (free tiers exist at metered.ca / Cloudflare Calls), or set `ICE_SERVERS` to a full JSON array.
* Private lines are enforced by each player's browser. Fine with friends; a hacked client could eavesdrop.

## Server rules
Server is authoritative: orders stay secret until the reveal, disconnected players can rejoin (same browser) and
are waited for 20s during planning (`DROP_GRACE_MS`). Rooms vanish 15 min after everyone leaves.

## Tests
    npm test
