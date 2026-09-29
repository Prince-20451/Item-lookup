require('dotenv').config({ path: require('path').join(__dirname, 'zoho.env') });
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const {
  CLIENT_ID,
  CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  INVENTORY_REFRESH_TOKEN,
  ZOHO_ORG_ID,
  ZOHO_DATA_CENTER = 'zohoapis.com',
} = process.env;

const ACCOUNTS_DOMAIN = {
  'zohoapis.com': 'accounts.zoho.com',
  'zohoapis.eu': 'accounts.zoho.eu',
  'zohoapis.in': 'accounts.zoho.in',
  'zohoapis.com.au': 'accounts.zoho.com.au',
  'zohoapis.jp': 'accounts.zoho.jp',
  'zohoapis.ca': 'accounts.zohocloud.ca',
  'zohoapis.com.cn': 'accounts.zoho.com.cn',
  'zohoapis.sa': 'accounts.zoho.sa',
};

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    const err = new Error('Server is missing CLIENT_ID, CLIENT_SECRET, or ZOHO_REFRESH_TOKEN environment variables.');
    err.isConfigError = true;
    throw err;
  }

  const accountsDomain = ACCOUNTS_DOMAIN[ZOHO_DATA_CENTER] || 'accounts.zoho.com';
  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://' + accountsDomain + '/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const body = await res.json().catch(() => null);

  if (!res.ok || !body || !body.access_token) {
    const msg = (body && (body.error || body.message)) || ('HTTP ' + res.status);
    throw new Error('Zoho token refresh failed: ' + msg);
  }

  cachedToken = body.access_token;
  // Refresh 2 minutes before actual expiry as a safety margin.
  cachedTokenExpiry = Date.now() + (Math.max(body.expires_in - 120, 60)) * 1000;
  return cachedToken;
}

async function zohoFetch(pathAndQuery, allowRetry = true) {
  const token = await getAccessToken();
  const res = await fetch('https://www.' + ZOHO_DATA_CENTER + pathAndQuery, {
    headers: { Authorization: 'Zoho-oauthtoken ' + token },
  });
  const body = await res.json().catch(() => null);

  // A freshly-minted token can occasionally get a spurious 401/403 if Zoho
  // hasn't fully propagated it yet. Force a new token and retry once.
  if ((res.status === 401 || res.status === 403) && allowRetry) {
    cachedToken = null;
    cachedTokenExpiry = 0;
    return zohoFetch(pathAndQuery, false);
  }

  return { ok: res.ok, status: res.status, body };
}

// --- Inventory API (separate OAuth scope, used only for serial number lookups) ---

let cachedInventoryToken = null;
let cachedInventoryTokenExpiry = 0;

async function getInventoryAccessToken() {
  if (cachedInventoryToken && Date.now() < cachedInventoryTokenExpiry) {
    return cachedInventoryToken;
  }
  if (!CLIENT_ID || !CLIENT_SECRET || !INVENTORY_REFRESH_TOKEN) {
    const err = new Error('Server is missing CLIENT_ID, CLIENT_SECRET, or INVENTORY_REFRESH_TOKEN environment variables.');
    err.isConfigError = true;
    throw err;
  }

  const accountsDomain = ACCOUNTS_DOMAIN[ZOHO_DATA_CENTER] || 'accounts.zoho.com';
  const params = new URLSearchParams({
    refresh_token: INVENTORY_REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://' + accountsDomain + '/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const body = await res.json().catch(() => null);

  if (!res.ok || !body || !body.access_token) {
    const msg = (body && (body.error || body.message)) || ('HTTP ' + res.status);
    throw new Error('Zoho Inventory token refresh failed: ' + msg);
  }

  cachedInventoryToken = body.access_token;
  cachedInventoryTokenExpiry = Date.now() + (Math.max(body.expires_in - 120, 60)) * 1000;
  return cachedInventoryToken;
}

async function inventoryFetch(pathAndQuery, allowRetry = true) {
  const token = await getInventoryAccessToken();
  const res = await fetch('https://www.' + ZOHO_DATA_CENTER + pathAndQuery, {
    headers: { Authorization: 'Zoho-oauthtoken ' + token },
  });
  const body = await res.json().catch(() => null);

  if ((res.status === 401 || res.status === 403) && allowRetry) {
    cachedInventoryToken = null;
    cachedInventoryTokenExpiry = 0;
    return inventoryFetch(pathAndQuery, false);
  }

  return { ok: res.ok, status: res.status, body };
}

// --- Serial number index ---
// Zoho has no "find item by serial number" endpoint - only "list serial
// numbers for a known item_id". With 2,000+ items, scanning all of them on
// every search would be far too slow, so instead we build a local
// serial-number -> item_id map in the background, and searches just look it
// up. The index is rebuilt periodically to pick up newly added serials.

let serialIndex = new Map(); // lowercase serial number -> { itemId, itemName, serialNumber }
let serialIndexBuiltAt = 0;
let serialIndexBuilding = false;

async function fetchAllBooksItems() {
  const items = [];
  let page = 1;
  for (;;) {
    const qs = 'organization_id=' + encodeURIComponent(ZOHO_ORG_ID) + '&page=' + page + '&per_page=200';
    const result = await zohoFetch('/books/v3/items?' + qs);
    if (!result.ok) break;
    const pageItems = (result.body && result.body.items) || [];
    items.push(...pageItems);
    const hasMore = result.body && result.body.page_context && result.body.page_context.has_more_page;
    if (!hasMore) break;
    page += 1;
  }
  return items;
}

async function fetchSerialNumbersForItem(itemId) {
  const serials = [];
  let page = 1;
  for (;;) {
    const qs = 'organization_id=' + encodeURIComponent(ZOHO_ORG_ID) + '&item_id=' + itemId + '&page=' + page + '&per_page=200';
    const result = await inventoryFetch('/inventory/v1/items/serialnumbers?' + qs);
    if (!result.ok) break;
    const pageSerials = (result.body && result.body.serial_numbers) || [];
    serials.push(...pageSerials);
    const hasMore = result.body && result.body.page_context && result.body.page_context.has_more_page;
    if (!hasMore) break;
    page += 1;
  }
  return serials;
}

async function buildSerialIndex() {
  if (serialIndexBuilding) return;
  if (!CLIENT_ID || !CLIENT_SECRET || !INVENTORY_REFRESH_TOKEN || !ZOHO_ORG_ID) {
    console.log('Serial number index skipped: INVENTORY_REFRESH_TOKEN not configured.');
    return;
  }

  serialIndexBuilding = true;
  const nextIndex = new Map();

  try {
    const allItems = await fetchAllBooksItems();
    const trackedItems = allItems.filter(it => it.track_serial_number);

    for (const item of trackedItems) {
      try {
        const serials = await fetchSerialNumbersForItem(item.item_id);
        for (const s of serials) {
          if (!s.serialnumber) continue;
          nextIndex.set(s.serialnumber.toLowerCase(), {
            itemId: item.item_id,
            itemName: item.name,
            serialNumber: s.serialnumber,
          });
        }
      } catch (e) {
        console.log('Serial number fetch failed for item ' + item.item_id + ': ' + e.message);
      }
    }

    serialIndex = nextIndex;
    serialIndexBuiltAt = Date.now();
    console.log('Serial number index built: ' + serialIndex.size + ' serials across ' + trackedItems.length + ' items.');
  } catch (e) {
    console.log('Serial number index build failed: ' + e.message);
  } finally {
    serialIndexBuilding = false;
  }
}

app.get('/api/serial-index-status', (req, res) => {
  res.json({
    size: serialIndex.size,
    builtAt: serialIndexBuiltAt ? new Date(serialIndexBuiltAt).toISOString() : null,
    building: serialIndexBuilding,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/item', async (req, res) => {
  const itemNumber = String(req.query.number || '').trim();
  if (!itemNumber) {
    return res.status(400).json({ error: 'Missing "number" query parameter.' });
  }
  if (!ZOHO_ORG_ID) {
    return res.status(500).json({ error: 'Server is missing ZOHO_ORG_ID environment variable.' });
  }

  try {
    const qs = 'organization_id=' + encodeURIComponent(ZOHO_ORG_ID);

    let result = await zohoFetch('/books/v3/items?' + qs + '&sku=' + encodeURIComponent(itemNumber));
    if (!result.ok) {
      return res.status(result.status).json({ error: (result.body && result.body.message) || 'Zoho API error' });
    }

    let items = (result.body && result.body.items) || [];

    // Fallback: exact sku filter can miss items indexed under item_name;
    // retry with a general text search and match locally.
    if (items.length === 0) {
      result = await zohoFetch('/books/v3/items?' + qs + '&search_text=' + encodeURIComponent(itemNumber));
      if (!result.ok) {
        return res.status(result.status).json({ error: (result.body && result.body.message) || 'Zoho API error' });
      }
      const candidates = (result.body && result.body.items) || [];
      items = candidates.filter(it =>
        (it.sku && it.sku.toLowerCase() === itemNumber.toLowerCase()) ||
        (it.name && it.name.toLowerCase() === itemNumber.toLowerCase())
      );
    }

    let matchedBy = 'name_or_sku';
    let matchedItemId = items[0] && items[0].item_id;

    // Fallback: no match by SKU/name - check the serial number index.
    if (items.length === 0) {
      const serialMatch = serialIndex.get(itemNumber.toLowerCase());
      if (serialMatch) {
        matchedBy = 'serial_number';
        matchedItemId = serialMatch.itemId;
      }
    }

    if (!matchedItemId) {
      return res.status(404).json({ error: 'not_found' });
    }

    const detail = await zohoFetch('/books/v3/items/' + matchedItemId + '?' + qs);
    if (!detail.ok) {
      return res.status(detail.status).json({ error: (detail.body && detail.body.message) || 'Zoho API error' });
    }

    const responseItem = (detail.body && detail.body.item) || items[0];
    res.json({ item: responseItem, matched_by: matchedBy, organization_id: ZOHO_ORG_ID });
  } catch (err) {
    res.status(err.isConfigError ? 500 : 502).json({ error: err.message });
  }
});

const SERIAL_INDEX_REBUILD_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  buildSerialIndex();
  setInterval(buildSerialIndex, SERIAL_INDEX_REBUILD_INTERVAL_MS);
});
