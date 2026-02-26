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
import { main as runFetch } from './scripts/fetch-all.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && !key.startsWith('#')) process.env[key.trim()] = val.join('=').trim();
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
  const { placeId, name, address, rating, totalRatings } = req.body;
  if (!placeId) return res.status(400).json({ error: 'placeId required' });
  const data = loadPortfolios();
  const folder = data.folders.find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (folder.hotels.find(h => h.placeId === placeId)) {
    return res.status(409).json({ error: 'Hotel already in folder' });
  }
  try {
    const full = await fetchHotelDetails(placeId);
    const now = new Date().toISOString();
    const hotel = {
      placeId, name: full.name || name, address: full.address || address,
      rating: full.rating ?? rating, totalRatings: full.totalRatings ?? totalRatings,
      lat: full.lat, lng: full.lng,
      savedAt: now, lastFetched: now,
      cachedData: { googleMapsUrl: full.googleMapsUrl, website: full.website, phone: full.phone, reviews: full.reviews, photos: full.photos }
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
    const full = await fetchHotelDetails(req.params.placeId);
    hotel.rating = full.rating;
    hotel.totalRatings = full.totalRatings;
    hotel.lat = full.lat;
    hotel.lng = full.lng;
    hotel.lastFetched = new Date().toISOString();
    hotel.cachedData = { googleMapsUrl: full.googleMapsUrl, website: full.website, phone: full.phone, reviews: full.reviews, photos: full.photos };
    savePortfolios(data);
    res.json({ ok: true, lastFetched: hotel.lastFetched });
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

// API: status — which API keys are configured
app.get('/api/status', (req, res) => {
  res.json({
    google: !!(process.env.GOOGLE_PLACES_API_KEY && process.env.GOOGLE_PLACES_API_KEY !== 'your_google_places_api_key_here'),
    tripadvisor: !!(process.env.TRIPADVISOR_API_KEY && process.env.TRIPADVISOR_API_KEY !== 'your_tripadvisor_api_key_here'),
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
