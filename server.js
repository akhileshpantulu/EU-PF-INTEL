/**
 * server.js
 * Express server that:
 *   - Serves the static dashboard at /
 *   - Exposes portfolio data at /api/portfolio
 *   - Exposes metadata at /api/metadata
 *   - Auto-opens browser on start
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import open from 'open';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { main as runFetch } from './scripts/fetch-all.js';

function getClaudeClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_anthropic_api_key_here') return null;
  return new Anthropic({ apiKey });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && !key.startsWith('#') && !process.env[key.trim()]) process.env[key.trim()] = val.join('=').trim();
  });
}

// ─── Saved Portfolios helpers ────────────────────────────────────────────────
const PORTFOLIOS_PATH = path.join(__dirname, 'saved-portfolios.json');

function loadPortfolios() {
  if (!fs.existsSync(PORTFOLIOS_PATH)) return { folders: [] };
  try { return JSON.parse(fs.readFileSync(PORTFOLIOS_PATH, 'utf8')); }
  catch { return { folders: [] }; }
}

function savePortfolios(data) {
  fs.writeFileSync(PORTFOLIOS_PATH, JSON.stringify(data, null, 2), 'utf8');
  syncToGitHub(data).catch(err => console.error(chalk.yellow('  GitHub sync failed:'), err.message));
}

async function syncToGitHub(data) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return;
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const apiUrl = `https://api.github.com/repos/${repo}/contents/saved-portfolios.json`;
  const headers = { Authorization: `token ${token}`, 'User-Agent': 'portfolio-intel' };
  let sha;
  try {
    const existing = await axios.get(apiUrl, { headers, params: { ref: branch } });
    sha = existing.data.sha;
  } catch (e) {
    if (e.response?.status !== 404) throw e;
  }
  await axios.put(apiUrl,
    { message: 'chore: update saved-portfolios.json', content, branch, ...(sha ? { sha } : {}) },
    { headers: { ...headers, 'Content-Type': 'application/json' } }
  );
  console.log(chalk.green('  GitHub sync: saved-portfolios.json committed'));
}

async function fetchHotelDetails(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('Google API key not configured');
  const r = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
    params: {
      place_id: placeId,
      fields: 'name,rating,user_ratings_total,reviews,photos,website,formatted_phone_number,url,formatted_address,geometry',
      key: apiKey
    }
  });
  const d = r.data.result;
  return {
    placeId,
    name: d.name,
    address: d.formatted_address,
    rating: d.rating,
    totalRatings: d.user_ratings_total,
    lat: d.geometry?.location?.lat,
    lng: d.geometry?.location?.lng,
    googleMapsUrl: d.url,
    website: d.website,
    phone: d.formatted_phone_number,
    reviews: (d.reviews || []).map(rv => ({
      author: rv.author_name, rating: rv.rating, text: rv.text,
      time: rv.time, timeDescription: rv.relative_time_description,
      profilePhoto: rv.profile_photo_url
    })),
    photos: (d.photos || []).slice(0, 20).map(p => ({
      url: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${p.photo_reference}&key=${apiKey}`,
      width: p.width, height: p.height
    }))
  };
}

async function fetchTAHotelDetails(locationId) {
  const apiKey = process.env.TRIPADVISOR_API_KEY;
  if (!apiKey) throw new Error('TripAdvisor API key not configured');
  // Key must be passed as ?key= query param (same as fetch-tripadvisor.js batch script)
  const taClient = axios.create({
    baseURL: 'https://api.content.tripadvisor.com/api/v1',
    headers: { accept: 'application/json' },
    params: { key: apiKey },
  });
  try {
    const [detRes, revRes, photoRes] = await Promise.all([
      taClient.get(`/location/${locationId}/details`, { params: { language: 'en', currency: 'USD' } }),
      taClient.get(`/location/${locationId}/reviews`, { params: { language: 'en', limit: 5 } }),
      taClient.get(`/location/${locationId}/photos`,  { params: { language: 'en', limit: 20 } }),
    ]);
    const d = detRes.data;
    const subratings = d.subratings
      ? Object.fromEntries(Object.entries(d.subratings).map(([k, v]) => [k, { name: v.localized_name, value: parseFloat(v.value) }]))
      : {};
    return {
      locationId,
      tripadvisorUrl: d.web_url,
      name: d.name,
      address: d.address_obj?.address_string,
      rating: parseFloat(d.rating) || null,
      numReviews: d.num_reviews,
      numRooms: d.num_rooms || null,
      rankingString: d.ranking_data?.ranking_string,
      priceLevel: d.price_level,
      subratings,
      reviews: (revRes.data?.data || []).map(rv => ({
        id: rv.id, title: rv.title, text: rv.text, rating: rv.rating,
        publishedDate: rv.published_date, helpfulVotes: rv.helpful_votes,
        tripType: rv.trip_type, travelDate: rv.travel_date,
        user: { username: rv.user?.username, userLocation: rv.user?.user_location?.name },
        url: rv.url,
      })),
      photos: (photoRes.data?.data || []).map(ph => ({
        id: ph.id, caption: ph.caption,
        images: {
          thumbnail: ph.images?.thumbnail?.url, small: ph.images?.small?.url,
          medium: ph.images?.medium?.url, large: ph.images?.large?.url,
          original: ph.images?.original?.url,
        },
      })),
    };
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error
      || `${err.message}${err.response?.status ? ` (HTTP ${err.response.status})` : ''}`;
    throw new Error(msg);
  }
}

async function lookupRoomsViaClaude(name, address) {
  const claude = getClaudeClient();
  if (!claude) {
    console.log('[Claude] No API key configured — skipping room lookup');
    return null;
  }
  const prompt = `You are a hotel industry database. What is the exact total number of guest rooms (keys) at "${name}" located at "${address}"? Think carefully — recall the specific property, not a similar-named one. Reply with ONLY a single integer (e.g. 316). If you cannot find this specific property with confidence, reply with the single word null.`;
  try {
    const res = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: [{ role: 'user', content: prompt }]
    });
    const textBlock = res.content.find(b => b.type === 'text');
    const raw = textBlock?.text?.trim() || '';
    console.log(`[Claude] room count for "${name}": "${raw}"`);
    const n = parseInt(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    console.error('[Claude] room lookup error:', err.message);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3737');
const app = express();

app.use(express.json());

// Serve static dashboard
app.use(express.static(path.join(__dirname, 'dashboard')));

// API: portfolio data
app.get('/api/portfolio', (req, res) => {
  const portfolioPath = path.join(__dirname, 'data', 'portfolio.json');
  if (!fs.existsSync(portfolioPath)) {
    return res.status(404).json({
      error: 'No portfolio data found. Run `npm run fetch` first.'
    });
  }
  const data = JSON.parse(fs.readFileSync(portfolioPath, 'utf8'));
  res.json(data);
});

// API: metadata
app.get('/api/metadata', (req, res) => {
  const metaPath = path.join(__dirname, 'data', 'metadata.json');
  if (!fs.existsSync(metaPath)) {
    return res.json({ lastFetch: null });
  }
  res.json(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
});

// API: properties config
app.get('/api/properties', (req, res) => {
  const propsPath = path.join(__dirname, 'properties.json');
  res.json(JSON.parse(fs.readFileSync(propsPath, 'utf8')));
});

// API: search any hotel via Google Places
app.get('/api/search', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q || q.length < 2) return res.json([]);
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Google API key not configured' });
  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query: q, type: 'lodging', key: apiKey }
    });
    res.json(r.data.results.slice(0, 8).map(x => ({
      placeId: x.place_id, name: x.name,
      address: x.formatted_address, rating: x.rating, totalRatings: x.user_ratings_total
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: full details for one hotel by placeId
app.get('/api/hotel', async (req, res) => {
  const { placeId } = req.query;
  if (!placeId) return res.status(400).json({ error: 'placeId required' });
  try {
    res.json(await fetchHotelDetails(placeId));
  } catch (err) {
    const status = err.message.includes('not configured') ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

// API: search hotels by name on TripAdvisor
app.get('/api/ta-search', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q || q.length < 2) return res.json([]);
  const apiKey = process.env.TRIPADVISOR_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'TripAdvisor API key not configured' });
  try {
    const taClient = axios.create({
      baseURL: 'https://api.content.tripadvisor.com/api/v1',
      headers: { accept: 'application/json' },
      params: { key: apiKey },
    });
    const r = await taClient.get('/location/search', {
      params: { searchQuery: q, category: 'hotels', language: 'en' },
    });
    res.json((r.data?.data || []).slice(0, 5).map(x => ({
      locationId: x.location_id,
      name: x.name,
      address: x.address_obj?.address_string || '',
    })));
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.error || err.message;
    res.status(500).json({ error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// API: full TripAdvisor details for one hotel by locationId
app.get('/api/ta-hotel', async (req, res) => {
  const { locationId } = req.query;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  try {
    res.json(await fetchTAHotelDetails(locationId));
  } catch (err) {
    res.status(err.message.includes('not configured') ? 503 : 500).json({ error: err.message });
  }
});

// API: trigger re-fetch (runs fetch-all in the background)
app.post('/api/refresh', (req, res) => {
  res.status(202).json({ message: 'Refresh started.' });
  runFetch().catch(err => console.error(chalk.red('Background refresh failed:'), err));
});

// ─── Saved Folders API ───────────────────────────────────────────────────────

// GET /api/folders — all folders, slim (no cachedData)
app.get('/api/folders', (req, res) => {
  const data = loadPortfolios();
  const slim = data.folders.map(f => ({
    id: f.id, name: f.name, createdAt: f.createdAt,
    hotels: f.hotels.map(h => ({
      placeId: h.placeId, name: h.name, address: h.address,
      rating: h.rating, totalRatings: h.totalRatings,
      numRooms: h.numRooms ?? null,
      taRating: h.cachedData?.tripadvisor?.rating ?? null,
      taNumReviews: h.cachedData?.tripadvisor?.numReviews ?? null,
      savedAt: h.savedAt, lastFetched: h.lastFetched,
      lat: h.lat, lng: h.lng
    }))
  }));
  res.json(slim);
});

// POST /api/folders — create a folder
app.post('/api/folders', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const data = loadPortfolios();
  const folder = { id: `f_${Date.now()}`, name: name.trim(), createdAt: new Date().toISOString(), hotels: [] };
  data.folders.push(folder);
  savePortfolios(data);
  res.status(201).json(folder);
});

// DELETE /api/folders/:id — delete a folder
app.delete('/api/folders/:id', (req, res) => {
  const data = loadPortfolios();
  const before = data.folders.length;
  data.folders = data.folders.filter(f => f.id !== req.params.id);
  if (data.folders.length === before) return res.status(404).json({ error: 'Folder not found' });
  savePortfolios(data);
  res.json({ ok: true });
});

// POST /api/folders/:id/hotels — save a hotel (fetches + caches immediately)
app.post('/api/folders/:id/hotels', async (req, res) => {
  const { placeId, name, address, rating, totalRatings, taLocationId } = req.body;
  if (!placeId) return res.status(400).json({ error: 'placeId required' });
  const data = loadPortfolios();
  const folder = data.folders.find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (folder.hotels.find(h => h.placeId === placeId)) {
    return res.status(409).json({ error: 'Hotel already in folder' });
  }
  try {
    const [full, taFull, claudeRooms] = await Promise.all([
      fetchHotelDetails(placeId),
      taLocationId ? fetchTAHotelDetails(taLocationId).catch(() => null) : Promise.resolve(null),
      lookupRoomsViaClaude(name || '', address || '').catch(() => null),
    ]);
    const now = new Date().toISOString();
    const hotel = {
      placeId, name: full.name || name, address: full.address || address,
      rating: full.rating ?? rating, totalRatings: full.totalRatings ?? totalRatings,
      lat: full.lat, lng: full.lng,
      numRooms: claudeRooms || null,
      savedAt: now, lastFetched: now,
      cachedData: { googleMapsUrl: full.googleMapsUrl, website: full.website, phone: full.phone, reviews: full.reviews, photos: full.photos, tripadvisor: taFull }
    };
    folder.hotels.push(hotel);
    savePortfolios(data);
    const { cachedData, ...slim } = hotel;
    res.status(201).json(slim);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/folders/:folderId/hotels/:placeId — remove hotel from folder
app.delete('/api/folders/:folderId/hotels/:placeId', (req, res) => {
  const data = loadPortfolios();
  const folder = data.folders.find(f => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const before = folder.hotels.length;
  folder.hotels = folder.hotels.filter(h => h.placeId !== req.params.placeId);
  if (folder.hotels.length === before) return res.status(404).json({ error: 'Hotel not found' });
  savePortfolios(data);
  res.json({ ok: true });
});

// POST /api/folders/:folderId/hotels/:placeId/refresh — re-fetch cached data
app.post('/api/folders/:folderId/hotels/:placeId/refresh', async (req, res) => {
  const data = loadPortfolios();
  const folder = data.folders.find(f => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const hotel = folder.hotels.find(h => h.placeId === req.params.placeId);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
  try {
    const taLocationId = hotel.cachedData?.tripadvisor?.locationId;
    const [full, taFull, claudeRooms] = await Promise.all([
      fetchHotelDetails(req.params.placeId),
      taLocationId ? fetchTAHotelDetails(taLocationId).catch(() => null) : Promise.resolve(null),
      hotel.numRooms ? Promise.resolve(hotel.numRooms) : lookupRoomsViaClaude(hotel.name, hotel.address).catch(() => null),
    ]);
    hotel.rating = full.rating;
    hotel.totalRatings = full.totalRatings;
    hotel.lat = full.lat;
    hotel.lng = full.lng;
    if (claudeRooms) hotel.numRooms = claudeRooms;
    hotel.lastFetched = new Date().toISOString();
    hotel.cachedData = { googleMapsUrl: full.googleMapsUrl, website: full.website, phone: full.phone, reviews: full.reviews, photos: full.photos, tripadvisor: taFull || hotel.cachedData?.tripadvisor };
    savePortfolios(data);
    res.json({ ok: true, lastFetched: hotel.lastFetched, numRooms: hotel.numRooms ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/folders/:folderId/hotels/:placeId — full cached data
app.get('/api/folders/:folderId/hotels/:placeId', (req, res) => {
  const data = loadPortfolios();
  const folder = data.folders.find(f => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const hotel = folder.hotels.find(h => h.placeId === req.params.placeId);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
  res.json({ ...hotel, folderId: folder.id, folderName: folder.name });
});

// PATCH /api/folders/:folderId/hotels/:placeId/rooms — persist Claude-looked-up room count
app.patch('/api/folders/:folderId/hotels/:placeId/rooms', (req, res) => {
  const numRooms = parseInt(req.body?.numRooms);
  if (!Number.isFinite(numRooms) || numRooms <= 0) return res.status(400).json({ error: 'valid numRooms required' });
  const data = loadPortfolios();
  const folder = data.folders.find(f => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const hotel = folder.hotels.find(h => h.placeId === req.params.placeId);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
  hotel.numRooms = numRooms;
  savePortfolios(data);
  res.json({ ok: true });
});

// GET /api/rooms-lookup?name=...&address=... — Claude-powered room count lookup
app.get('/api/rooms-lookup', async (req, res) => {
  const { name, address } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const numRooms = await lookupRoomsViaClaude(name, address || '');
    res.json({ numRooms });
  } catch (err) {
    console.error('[Claude] rooms-lookup error:', err.response?.data || err.message);
    res.json({ numRooms: null }); // fail gracefully — never block the UI
  }
});

// GET /api/test-claude — diagnostic: make a real Claude call and return raw response
app.get('/api/test-claude', async (req, res) => {
  const claude = getClaudeClient();
  if (!claude) {
    return res.json({ error: 'ANTHROPIC_API_KEY not set or still placeholder', keyPresent: false });
  }
  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: [{ role: 'user', content: 'You are a hotel industry database. What is the exact total number of guest rooms (keys) at "JW Marriott Houston" located at "806 Main St, Houston, TX"? Think carefully — recall the specific property, not a similar-named one. Reply with ONLY a single integer (e.g. 316). If you cannot find this specific property with confidence, reply with the single word null.' }]
    });
    const textBlock = response.content.find(b => b.type === 'text');
    const raw = textBlock?.text?.trim() || '';
    res.json({ keyPresent: true, model: 'claude-sonnet-4-6 (extended thinking)', raw, parsed: parseInt(raw) || null });
  } catch (err) {
    res.json({ keyPresent: true, error: err.message });
  }
});

// POST /api/review-analysis — Claude-powered sentiment analysis: top 3 best + worst reviews + summary
app.post('/api/review-analysis', async (req, res) => {
  const { name, googleReviews = [], taReviews = [], folderId, placeId } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  // Return disk-cached result for saved hotels
  if (folderId && placeId) {
    const data = loadPortfolios();
    const folder = data.folders.find(f => f.id === folderId);
    const hotel = folder?.hotels.find(h => h.placeId === placeId);
    if (hotel?.cachedData?.reviewAnalysis) {
      return res.json(hotel.cachedData.reviewAnalysis);
    }
  }

  const claude = getClaudeClient();
  if (!claude) return res.json({ summary: null, top3best: [], top3worst: [] });

  const gReviews = (googleReviews || []).slice(0, 5)
    .filter(r => r.text?.trim())
    .map(r => ({ source: 'Google', rating: r.rating, author: r.author || 'Guest', title: '', text: r.text }));
  const tReviews = [...(taReviews || [])]
    .sort((a, b) => (b.helpfulVotes || 0) - (a.helpfulVotes || 0))
    .slice(0, 20)
    .filter(r => r.text?.trim())
    .map(r => ({ source: 'TripAdvisor', rating: r.rating, author: r.user?.username || 'Guest', title: r.title || '', text: r.text }));
  const combined = [...gReviews, ...tReviews];

  if (combined.length === 0)
    return res.json({ summary: null, top3best: [], top3worst: [] });

  const reviewsText = combined.map((r, i) =>
    `[${i + 1}] Source: ${r.source} | Rating: ${r.rating}/5 | Author: ${r.author}${r.title ? ` | Title: "${r.title}"` : ''}\n"${r.text.slice(0, 500)}"`
  ).join('\n\n');

  const prompt = `You are a hospitality analyst. Analyze these ${combined.length} guest reviews for the hotel "${name}".

${reviewsText}

Return a JSON object with EXACTLY this structure:
{
  "summary": "2-3 sentences describing overall guest sentiment, the most praised aspects, and the most common criticisms",
  "top3best": [
    { "quote": "verbatim excerpt from a positive review, max 120 chars", "rating": 5, "source": "Google or TripAdvisor", "author": "reviewer name" }
  ],
  "top3worst": [
    { "quote": "verbatim excerpt from a critical review, max 120 chars", "rating": 2, "source": "Google or TripAdvisor", "author": "reviewer name" }
  ]
}
Select the 3 most informative/representative reviews for each category. Quotes must be verbatim from the text above.`;

  try {
    const claudeRes = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = claudeRes.content[0]?.text?.trim() || '{}';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    const result = JSON.parse(cleaned);

    // Persist to disk for saved hotels so next view is instant
    if (folderId && placeId) {
      const data = loadPortfolios();
      const folder = data.folders.find(f => f.id === folderId);
      const hotel = folder?.hotels.find(h => h.placeId === placeId);
      if (hotel) {
        hotel.cachedData = hotel.cachedData || {};
        hotel.cachedData.reviewAnalysis = result;
        savePortfolios(data);
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[Claude] review-analysis error:', err.message);
    res.json({ summary: null, top3best: [], top3worst: [] });
  }
});

// API: status — which API keys are configured
app.get('/api/status', (req, res) => {
  res.json({
    google: !!(process.env.GOOGLE_PLACES_API_KEY && process.env.GOOGLE_PLACES_API_KEY !== 'your_google_places_api_key_here'),
    tripadvisor: !!(process.env.TRIPADVISOR_API_KEY && process.env.TRIPADVISOR_API_KEY !== 'your_tripadvisor_api_key_here'),
    claude: !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here'),
    github: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
  });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(chalk.bold.green('\n═══════════════════════════════════════════'));
  console.log(chalk.bold.green('  PORTFOLIO INTEL DASHBOARD'));
  console.log(chalk.bold.green('═══════════════════════════════════════════'));
  console.log(chalk.green(`  Running at: ${chalk.bold.white(url)}`));
  console.log(chalk.gray('  Press Ctrl+C to stop\n'));

  // Auto-open browser (only in interactive/local terminal sessions)
  if (process.stdout.isTTY) {
    try {
      await open(url);
      console.log(chalk.gray('  Browser opened automatically'));
    } catch {
      console.log(chalk.gray('  Open your browser and navigate to the URL above'));
    }
  }
});
