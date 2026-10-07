# Snake in a Post

Snake that you play right inside a post on X. It works like jaivin's Minecraft post: a player card in the timeline, and **everyone who opens the embed plays in the same world**.

- One shared 72×72 arena. The server runs the whole game; clients only send their direction
- The world is never empty: when fewer than 4 snakes are alive, bots fill the gaps
- When you die, your body turns into food for everyone else. The kill feed shows who ate whom
- Top 5 leaderboard, online counter, minimap, smooth animation
- Controls: arrow keys / WASD, swipe on mobile

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Open it in two tabs and you'll see yourself in both.

## Put it in a post

1. **Deploy to any HTTPS host that supports WebSockets.** Easiest: Render.com → New → Web Service → this repo. Build: `npm install`, Start: `npm start`. Fly.io and Railway work too (there's a `Dockerfile`).
2. **Set the `PUBLIC_URL` env variable** to your site's address, e.g. `https://snake-xyz.onrender.com`. Without it the server takes the address from the request, but an explicit URL is more reliable for the card.
3. **Paste the link into a post.** X reads the `twitter:card=player` meta tags and shows the game right in the timeline (480×480 card, poster at `public/poster.png`).

Good to know:
- X decides whether to render the live player. If it doesn't, the post shows the poster image with a link, and the game opens on click.
- On Render's free plan the server sleeps after 15 minutes without traffic. The first visit after that takes about a minute. For a post you expect to take off, use a paid instance or Fly.io.
- One process for everyone, no database: restarting the server means a fresh world.

## Settings

All at the top of `server.js`:

| Constant | What it does | Default |
|---|---|---|
| `W`, `H` | world size in cells | 72 × 72 |
| `TICK_MS` | game speed (lower = faster) | 110 |
| `MIN_SNAKES` | how many snakes bots keep in the world | 4 |
| `START_LEN` | starting length | 4 |

## Files

```
server.js          server: HTTP + WebSocket, game loop, bots, card meta tags
public/index.html  client: canvas, HUD, controls
public/poster.png  preview image for the X card
public/favicon.svg
Dockerfile
```
