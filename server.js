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

const PORT = parseInt(process.env.PORT || '3737');
const app = express();

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
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Google API key not configured' });
  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id: placeId,
        fields: 'name,rating,user_ratings_total,reviews,photos,website,formatted_phone_number,url,formatted_address',
        key: apiKey
      }
    });
    const d = r.data.result;
    res.json({
      placeId, name: d.name, address: d.formatted_address,
      rating: d.rating, totalRatings: d.user_ratings_total,
      googleMapsUrl: d.url, website: d.website, phone: d.formatted_phone_number,
      reviews: (d.reviews || []).map(rv => ({
        author: rv.author_name, rating: rv.rating, text: rv.text,
        time: rv.time, timeDescription: rv.relative_time_description,
        profilePhoto: rv.profile_photo_url
      })),
      photos: (d.photos || []).slice(0, 20).map(p => ({
        url: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${p.photo_reference}&key=${apiKey}`,
        width: p.width, height: p.height
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: trigger re-fetch (runs fetch-all in the background)
app.post('/api/refresh', (req, res) => {
  res.status(202).json({ message: 'Refresh started.' });
  runFetch().catch(err => console.error(chalk.red('Background refresh failed:'), err));
});

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
