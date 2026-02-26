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

// API: trigger re-fetch (useful for scheduled updates)
app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Refresh triggered. Run `npm run fetch` in terminal.' });
});

app.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(chalk.bold.green('\n═══════════════════════════════════════════'));
  console.log(chalk.bold.green('  PORTFOLIO INTEL DASHBOARD'));
  console.log(chalk.bold.green('═══════════════════════════════════════════'));
  console.log(chalk.green(`  Running at: ${chalk.bold.white(url)}`));
  console.log(chalk.gray('  Press Ctrl+C to stop\n'));

  // Auto-open browser
  try {
    await open(url);
    console.log(chalk.gray('  Browser opened automatically'));
  } catch {
    console.log(chalk.gray('  Open your browser and navigate to the URL above'));
  }
});
