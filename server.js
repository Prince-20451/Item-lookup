require('dotenv').config({ path: require('path').join(__dirname, 'zoho.env') });
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const {
  CLIENT_ID,
  CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
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

    if (items.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }

    const detail = await zohoFetch('/books/v3/items/' + items[0].item_id + '?' + qs);
    if (!detail.ok) {
      return res.status(detail.status).json({ error: (detail.body && detail.body.message) || 'Zoho API error' });
    }

    res.json({ item: (detail.body && detail.body.item) || items[0] });
  } catch (err) {
    res.status(err.isConfigError ? 500 : 502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
