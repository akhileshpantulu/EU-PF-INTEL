# Portfolio Intel — Review Dashboard

Competitive intelligence dashboard showing Google and TripAdvisor reviews + photos
for 18 hotel properties. Runs locally via Express, fetches data via official APIs.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up API keys
cp .env.example .env
# Then edit .env and add your keys

# 3. Fetch data (first run takes ~3–5 minutes)
npm run fetch

# 4. Launch dashboard
npm start
# Dashboard opens automatically at http://localhost:3737
```

---

## API Keys Setup

### Google Places API (~$0.30 per full run for 18 properties)
1. Go to https://console.cloud.google.com
2. Create or select a project
3. Enable **Places API** (not "Places API (New)" — use the classic one)
4. Go to Credentials → Create API Key
5. Optional: Restrict key to "Places API" for security
6. Copy key to `.env` as `GOOGLE_PLACES_API_KEY`

**What you get:**
- Overall Google rating + total review count
- Up to 5 recent reviews (text, author, rating, date)
- Up to 10 property photos
- Google Maps URL

### TripAdvisor Content API (Free: 5,000 calls/month)
1. Go to https://www.tripadvisor.com/developers
2. Sign up for a developer account
3. Create an app to get your API key
4. Copy key to `.env` as `TRIPADVISOR_API_KEY`

**What you get:**
- TripAdvisor rating + review count
- Subratings (cleanliness, service, value, location, rooms)
- City ranking string ("#3 of 87 hotels in Houston")
- Up to 5 recent reviews with trip type
- Up to 10 property photos
- TripAdvisor page URL

---

## Commands

| Command | Description |
|---|---|
| `npm run fetch` | Fetch all data from both APIs |
| `npm run fetch:google` | Fetch Google data only |
| `npm run fetch:tripadvisor` | Fetch TripAdvisor data only |
| `npm start` | Start the dashboard server |
| `npm run dev` | Fetch + start in sequence |

---

## Dashboard Features

- **Sidebar**: All 18 properties with mini ratings, search + sort
- **Portfolio Overview**: Full comparison table, CSV export
- **Property Detail**:
  - Google + TripAdvisor ratings side by side
  - TripAdvisor subratings (cleanliness, service, etc.)
  - City ranking from TripAdvisor
  - Review filtering by source (Google / TripAdvisor / All)
  - Photo gallery with lightbox (keyboard nav: ← →, Esc to close)
  - Direct links to Google Maps and TripAdvisor pages

---

## Data Files

```
data/
  google.json        # Raw Google Places data per property
  tripadvisor.json   # Raw TripAdvisor data per property
  portfolio.json     # Merged data (what the dashboard reads)
  metadata.json      # Last fetch time + success counts
```

Data is saved incrementally — if a fetch crashes mid-way, progress is preserved.

---

## Property List

| # | Property | City |
|---|---|---|
| 1 | Denver Tech Center Marriott | Denver, CO |
| 2 | Denver West Marriott | Denver, CO |
| 3 | Embassy Suites Chicago | Chicago, IL |
| 4 | Gaithersburg Marriott | Gaithersburg, MD |
| 5 | Houston Airport Marriott | Houston, TX |
| 6 | Hyatt Place Waikiki Beach | Honolulu, HI |
| 7 | Hyatt Regency Reston | Reston, VA |
| 8 | JW Marriott Houston | Houston, TX |
| 9 | JW Marriott Buckhead Atlanta | Atlanta, GA |
| 10 | Minneapolis City Center Marriott | Minneapolis, MN |
| 11 | Philadelphia Airport Marriott | Philadelphia, PA |
| 12 | Tampa Airport Marriott | Tampa, FL |
| 13 | The Laura Hotel (Autograph Collection) | Houston, TX |
| 14 | The Logan (Curio Collection) | Philadelphia, PA |
| 15 | W Seattle | Seattle, WA |
| 16 | Westin River North Chicago | Chicago, IL |
| 17 | Westin Seattle | Seattle, WA |
| 18 | Westin Waltham Boston | Waltham, MA |

---

## Refreshing Data

Re-run `npm run fetch` anytime to pull fresh reviews and photos.
The fetch is idempotent — it will overwrite existing data cleanly.

Recommended: run weekly or before investment committee meetings.

---

## Troubleshooting

**"No results found" for a property:**
- Edit `properties.json` and adjust the `googleQuery` or `tripadvisorQuery` for that property
- More specific queries (include city, state) work better

**Rate limit errors (TripAdvisor):**
- The script auto-waits 10 seconds on 429 errors
- If persistent, wait an hour and re-run with `npm run fetch:tripadvisor`

**Google photo URLs expiring:**
- Google Places photo URLs contain your API key and work immediately
- Re-run `npm run fetch:google` to refresh photo references
