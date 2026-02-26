/**
 * fetch-tripadvisor.js
 * Fetches TripAdvisor Content API data for each property:
 *   - Overall rating, review count, subratings
 *   - All reviews from the last 3 years (paginated)
 *   - Up to 30 photos (split into traveler vs official)
 *
 * API: TripAdvisor Content API (free tier: 5,000 calls/month)
 * Signup: https://www.tripadvisor.com/developers
 * Docs: https://tripadvisor-content-api.readme.io/
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
const BASE_URL = 'https://api.content.tripadvisor.com/api/v1';
const DELAY_MS = 500;

const dataDir = path.join(ROOT, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

let taAxios; // Initialized inside main() once API_KEY is known

/**
 * Step 1: Search for location ID
 */
async function searchLocation(property) {
  const response = await taAxios.get('/location/search', {
    params: {
      searchQuery: property.tripadvisorQuery,
      category: 'hotels',
      language: 'en',
    }
  });

  const data = response.data?.data;
  if (!data || data.length === 0) {
    throw new Error(`No TripAdvisor results for "${property.tripadvisorQuery}"`);
  }

  return data[0]; // Most relevant result
}

/**
 * Step 2: Get location details (rating, subratings, etc.)
 */
async function getLocationDetails(locationId) {
  const response = await taAxios.get(`/location/${locationId}/details`, {
    params: {
      language: 'en',
      currency: 'USD',
    }
  });
  return response.data;
}

/**
 * Step 3: Get reviews (paginated, last 3 years)
 */
async function getLocationReviews(locationId) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 3);

  const allReviews = [];
  let offset = 0;
  let page = 0;

  while (true) {
    page++;
    const response = await taAxios.get(`/location/${locationId}/reviews`, {
      params: {
        language: 'en',
        limit: 5,
        offset,
      }
    });

    const reviews = response.data?.data || [];
    if (reviews.length === 0) break;

    let hitOldReview = false;
    for (const review of reviews) {
      const pubDate = new Date(review.published_date);
      if (pubDate >= cutoff) {
        allReviews.push(review);
      } else {
        hitOldReview = true;
        break;
      }
    }

    if (hitOldReview) break;

    offset += reviews.length;
    await sleep(DELAY_MS);
  }

  console.log(chalk.gray(`      → ${allReviews.length} reviews across ${page} page(s)`));
  return allReviews;
}

/**
 * Step 4: Get photos
 */
async function getLocationPhotos(locationId) {
  const response = await taAxios.get(`/location/${locationId}/photos`, {
    params: {
      language: 'en',
      limit: 30,
    }
  });
  return response.data?.data || [];
}

/**
 * Process a single property
 */
async function fetchProperty(property) {
  console.log(chalk.cyan(`  [${property.id}/18] ${property.name}...`));

  try {
    // Search for location
    const location = await searchLocation(property);
    const locationId = location.location_id;
    await sleep(DELAY_MS);

    // Get details, reviews, photos in parallel (with small stagger)
    const details = await getLocationDetails(locationId);
    await sleep(DELAY_MS);
    const reviews = await getLocationReviews(locationId);
    await sleep(DELAY_MS);
    const photos = await getLocationPhotos(locationId);
    await sleep(DELAY_MS);

    // Parse subratings
    const subratings = details.subratings ? Object.fromEntries(
      Object.entries(details.subratings).map(([k, v]) => [k, {
        name: v.localized_name,
        value: parseFloat(v.value),
      }])
    ) : {};

    // Parse reviews
    const parsedReviews = reviews.map(r => ({
      id: r.id,
      title: r.title,
      text: r.text,
      rating: r.rating,
      publishedDate: r.published_date,
      helpfulVotes: r.helpful_votes,
      tripType: r.trip_type,
      travelDate: r.travel_date,
      user: {
        username: r.user?.username,
        avatar: r.user?.avatar?.thumbnail?.url,
        userLocation: r.user?.user_location?.name,
      },
      url: r.url,
    }));

    // Parse photos
    const parsedPhotos = photos.map(p => ({
      id: p.id,
      caption: p.caption,
      publishedDate: p.published_date,
      source: p.source?.name || 'unknown',
      user: p.user?.username,
      images: {
        thumbnail: p.images?.thumbnail?.url,
        small: p.images?.small?.url,
        medium: p.images?.medium?.url,
        large: p.images?.large?.url,
        original: p.images?.original?.url,
      },
    }));

    return {
      propertyId: property.id,
      source: 'tripadvisor',
      fetchedAt: new Date().toISOString(),
      locationId,
      locationIdStr: locationId.toString(),
      tripadvisorUrl: details.web_url,
      name: details.name,
      address: details.address_obj?.address_string,
      rating: parseFloat(details.rating) || null,
      numReviews: details.num_reviews,
      rankingString: details.ranking_data?.ranking_string,
      rankingCategory: details.ranking_data?.ranking_category,
      priceLevel: details.price_level,
      priceRange: details.price,
      numRooms: details.num_rooms || null,
      subratings,
      awardedBadges: details.awards?.map(a => a.display_name) || [],
      reviews: parsedReviews,
      photos: parsedPhotos,
    };

  } catch (err) {
    console.error(chalk.red(`    ✗ Failed: ${err.message}`));

    // Check for rate limit
    if (err.response?.status === 429) {
      console.log(chalk.yellow('    ⏳ Rate limited — waiting 10 seconds...'));
      await sleep(10000);
    }

    return {
      propertyId: property.id,
      source: 'tripadvisor',
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
  API_KEY = process.env.TRIPADVISOR_API_KEY;
  if (!API_KEY || API_KEY === 'your_tripadvisor_api_key_here') {
    throw new Error('Missing TRIPADVISOR_API_KEY in environment');
  }

  taAxios = axios.create({
    baseURL: BASE_URL,
    headers: { accept: 'application/json' },
    params: { key: API_KEY },
  });

  const properties = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'properties.json'), 'utf8')
  );

  console.log(chalk.bold.yellow('\n🦅  TripAdvisor Content API Fetcher'));
  console.log(chalk.gray(`  Fetching ${properties.length} properties...\n`));

  const results = {};
  const outputPath = path.join(dataDir, 'tripadvisor.json');

  // Load existing so we can resume
  if (fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    existing.forEach(p => { results[p.propertyId] = p; });
  }

  for (const property of properties) {
    const data = await fetchProperty(property);
    results[property.id] = data;

    // Save incrementally
    fs.writeFileSync(outputPath, JSON.stringify(Object.values(results), null, 2));
  }

  const successCount = Object.values(results).filter(r => !r.error).length;
  const failCount = Object.values(results).filter(r => r.error).length;

  console.log(chalk.bold.yellow(`\n✅ TripAdvisor fetch complete`));
  console.log(chalk.yellow(`   Success: ${successCount}/${properties.length}`));
  if (failCount > 0) console.log(chalk.yellow(`   Failures: ${failCount}`));
  console.log(chalk.gray(`   Saved to data/tripadvisor.json\n`));
}

export { main };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(chalk.red('Fatal error:'), err);
    process.exit(1);
  });
}
