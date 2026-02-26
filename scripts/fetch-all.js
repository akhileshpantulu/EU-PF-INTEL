/**
 * fetch-all.js
 * Orchestrates fetching from all sources and generates the merged
 * portfolio.json that the dashboard reads from.
 *
 * Run: npm run fetch
 */

import { main as fetchGoogle } from './fetch-google.js';
import { main as fetchTripadvisor } from './fetch-tripadvisor.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Load env
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && !key.startsWith('#')) process.env[key.trim()] = val.join('=').trim();
  });
}

async function main() {
  const hasGoogle = process.env.GOOGLE_PLACES_API_KEY &&
    process.env.GOOGLE_PLACES_API_KEY !== 'your_google_places_api_key_here';

  const hasTA = process.env.TRIPADVISOR_API_KEY &&
    process.env.TRIPADVISOR_API_KEY !== 'your_tripadvisor_api_key_here';

  const properties = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'properties.json'), 'utf8')
  );

  console.log(chalk.bold('\n═══════════════════════════════════════════'));
  console.log(chalk.bold('  PORTFOLIO INTEL — Data Fetch'));
  console.log(chalk.bold('═══════════════════════════════════════════'));
  console.log(chalk.cyan(`  Google Places API:  ${hasGoogle ? chalk.green('✓ configured') : chalk.red('✗ missing key')}`));
  console.log(chalk.cyan(`  TripAdvisor API:    ${hasTA ? chalk.green('✓ configured') : chalk.red('✗ missing key')}`));
  console.log();

  // Run fetchers
  if (hasGoogle) {
    console.log(chalk.bold.green('Running Google Places fetcher...'));
    try {
      await fetchGoogle();
    } catch (e) {
      console.error(chalk.red('Google fetcher failed:'), e.message);
    }
  } else {
    console.log(chalk.yellow('⚠  Skipping Google (no API key)'));
  }

  if (hasTA) {
    console.log(chalk.bold.yellow('Running TripAdvisor fetcher...'));
    try {
      await fetchTripadvisor();
    } catch (e) {
      console.error(chalk.red('TripAdvisor fetcher failed:'), e.message);
    }
  } else {
    console.log(chalk.yellow('⚠  Skipping TripAdvisor (no API key)'));
  }

  // Merge into portfolio.json
  console.log(chalk.bold('\nMerging data into portfolio.json...'));

  const dataDir = path.join(ROOT, 'data');
  const googlePath = path.join(dataDir, 'google.json');
  const taPath = path.join(dataDir, 'tripadvisor.json');

  const googleData = fs.existsSync(googlePath)
    ? JSON.parse(fs.readFileSync(googlePath, 'utf8'))
    : [];

  const taData = fs.existsSync(taPath)
    ? JSON.parse(fs.readFileSync(taPath, 'utf8'))
    : [];

  // Build lookup maps
  const googleMap = {};
  googleData.forEach(g => { googleMap[g.propertyId] = g; });

  const taMap = {};
  taData.forEach(t => { taMap[t.propertyId] = t; });

  // Merge
  const portfolio = properties.map(p => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    city: p.city,
    state: p.state,
    address: p.address,
    google: googleMap[p.id] || null,
    tripadvisor: taMap[p.id] || null,
  }));

  // Summary stats
  const withGoogle = portfolio.filter(p => p.google && !p.google.error).length;
  const withTA = portfolio.filter(p => p.tripadvisor && !p.tripadvisor.error).length;

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'portfolio.json'),
    JSON.stringify(portfolio, null, 2)
  );

  // Write metadata
  const metadata = {
    lastFetch: new Date().toISOString(),
    propertyCount: properties.length,
    googleSuccess: withGoogle,
    taSuccess: withTA,
  };
  fs.writeFileSync(path.join(dataDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  // Copy data to docs/ for GitHub Pages static site
  const docsDataDir = path.join(ROOT, 'docs', 'data');
  if (!fs.existsSync(docsDataDir)) fs.mkdirSync(docsDataDir, { recursive: true });
  fs.copyFileSync(path.join(dataDir, 'portfolio.json'), path.join(docsDataDir, 'portfolio.json'));
  fs.copyFileSync(path.join(dataDir, 'metadata.json'), path.join(docsDataDir, 'metadata.json'));
  console.log(chalk.gray('   Copied data to docs/data/ for GitHub Pages'));

  console.log(chalk.bold.green('\n✅ Portfolio data ready!'));
  console.log(chalk.green(`   ${withGoogle}/${properties.length} properties have Google data`));
  console.log(chalk.green(`   ${withTA}/${properties.length} properties have TripAdvisor data`));
  console.log(chalk.gray(`   Saved to data/portfolio.json`));
  console.log(chalk.bold('\n→ Run `npm start` to launch the dashboard\n'));
}

export { main };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(chalk.red('Fatal error:'), err);
    process.exit(1);
  });
}
