/**
 * fetch-google.js
 * Fetches Google Places data for each property:
 *   - Overall rating, review count
 *   - Up to 5 most recent reviews (text, author, rating, date)
 *   - Up to 20 photo references (converted to usable URLs)
 *   - Place details (website, phone, hours)
 *
 * API: Google Places API (New)
 * Docs: https://developers.google.com/maps/documentation/places/web-service
 */

import axios from 'axios';
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

let API_KEY; // Set inside main() so this module is safe to import
const PHOTO_MAX_WIDTH = 800;
const MAX_PHOTOS = 60;
const DELAY_MS = 300; // Be polite to the API

const dataDir = path.join(ROOT, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Step 1: Text Search to find the Place ID
 */
async function findPlaceId(property) {
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
  const response = await axios.get(url, {
    params: {
      query: property.googleQuery,
      type: 'lodging',
      key: API_KEY,
    }
  });

  const results = response.data.results;
  if (!results || results.length === 0) {
    throw new Error(`No results found for "${property.googleQuery}"`);
  }

  // Return the first (most relevant) result
  return {
    placeId: results[0].place_id,
    name: results[0].name,
    rating: results[0].rating,
    totalRatings: results[0].user_ratings_total,
    address: results[0].formatted_address,
  };
}

/**
 * Step 2: Get full Place Details (reviews + photos)
 */
async function getPlaceDetails(placeId) {
  const url = 'https://maps.googleapis.com/maps/api/place/details/json';
  const response = await axios.get(url, {
    params: {
      place_id: placeId,
      fields: [
        'name',
        'rating',
        'user_ratings_total',
        'reviews',
        'photos',
        'website',
        'formatted_phone_number',
        'opening_hours',
        'url',
        'price_level',
      ].join(','),
      key: API_KEY,
    }
  });

  return response.data.result;
}

/**
 * Convert photo reference to direct URL
 */
function photoRefToUrl(photoReference) {
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${PHOTO_MAX_WIDTH}&photoreference=${photoReference}&key=${API_KEY}`;
}

/**
 * Main fetch function for a single property
 */
async function fetchProperty(property) {
  console.log(chalk.cyan(`  [${property.id}/18] ${property.name}...`));

  try {
    // Find place ID
    const basic = await findPlaceId(property);
    await sleep(DELAY_MS);

    // Get full details
    const details = await getPlaceDetails(basic.placeId);
    await sleep(DELAY_MS);

    // Process reviews
    const reviews = (details.reviews || []).map(r => ({
      author: r.author_name,
      rating: r.rating,
      text: r.text,
      time: r.time,
      timeDescription: r.relative_time_description,
      profilePhoto: r.profile_photo_url,
      googleMapsUrl: r.author_url,
    }));

    // Process photos (first MAX_PHOTOS)
    const photos = (details.photos || [])
      .slice(0, MAX_PHOTOS)
      .map(p => ({
        url: photoRefToUrl(p.photo_reference),
        width: p.width,
        height: p.height,
        attributions: p.html_attributions,
      }));

    return {
      propertyId: property.id,
      source: 'google',
      fetchedAt: new Date().toISOString(),
      placeId: basic.placeId,
      googleMapsUrl: details.url,
      website: details.website,
      phone: details.formatted_phone_number,
      rating: details.rating || basic.rating,
      totalRatings: details.user_ratings_total || basic.totalRatings,
      address: basic.address,
      reviews,
      photos,
      rawName: details.name,
    };

  } catch (err) {
    console.error(chalk.red(`    ✗ Failed: ${err.message}`));
    return {
      propertyId: property.id,
      source: 'google',
      fetchedAt: new Date().toISOString(),
      error: err.message,
      reviews: [],
      photos: [],
    };
  }
}

/**
 * Run all properties and save results
 */
async function main() {
  API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY || API_KEY === 'your_google_places_api_key_here') {
    throw new Error('Missing GOOGLE_PLACES_API_KEY in environment');
  }

  const properties = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'properties.json'), 'utf8')
  );

  console.log(chalk.bold.green('\n🗺  Google Places Fetcher'));
  console.log(chalk.gray(`  Fetching ${properties.length} properties...\n`));

  const results = {};
  const existingPath = path.join(dataDir, 'google.json');

  // Load existing data so we can skip or merge if needed
  if (fs.existsSync(existingPath)) {
    const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
    existing.forEach(p => { results[p.propertyId] = p; });
  }

  for (const property of properties) {
    const data = await fetchProperty(property);
    results[property.id] = data;

    // Save incrementally (so progress isn't lost on crash)
    fs.writeFileSync(
      existingPath,
      JSON.stringify(Object.values(results), null, 2)
    );
  }

  const successCount = Object.values(results).filter(r => !r.error).length;
  const failCount = Object.values(results).filter(r => r.error).length;

  console.log(chalk.bold.green(`\n✅ Google fetch complete`));
  console.log(chalk.green(`   Success: ${successCount}/${properties.length}`));
  if (failCount > 0) console.log(chalk.yellow(`   Failures: ${failCount}`));
  console.log(chalk.gray(`   Saved to data/google.json\n`));
}

export { main };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(chalk.red('Fatal error:'), err);
    process.exit(1);
  });
}
