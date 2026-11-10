// Prepare Zoho Fetch v3.32 — one fetch URL per successful upsert (P0 Apr 20)
//
// v3.32 FIX — Multi-contact confirmation showed wrong Zoho data
// Observed failure (Apr 20 2026, user paused use):
//   A single-contact email produced 5 upserts (the real contact + 4 over-extractions).
//   Prepare Zoho Fetch only built fetchUrl for the FIRST successful upsert.
//   Fetch Zoho Contact therefore ran ONCE, retrieving only that first record.
//   Prepare Confirmation Email then fell back to "sequential fetch data" for contacts 2-5,
//   which re-matched the first record to every subsequent contact — so a second contact's card
//   displayed the first contact's Zoho data. The user correctly flagged this as data corruption.
//
// v3.32 BEHAVIOR:
//   - Emit one output item per successful upsert, each with its own fetchUrl
//   - Fetch Zoho Contact runs N times, returning N items indexed by Zoho ID
//   - Prepare Confirmation Email (Run-Once-For-All-Items) iterates
//     $('Fetch Zoho Contact').all() and matches by zohoId — no sequential fallback drift
//   - If no successful upserts, emit a single skipped/failed item (prior shape preserved)
//
// v3.2.9f — reads ALL upsert responses for accurate confirmations
const allUpsertItems = $input.all();
const allPrepareItems = $('Prepare Upsert').all();
const prepareData = allPrepareItems[allPrepareItems.length - 1]?.json || {};

if (prepareData.zohoSkipped) {
  return [{
    json: {
      ...prepareData,
      zohoResults: [],
      zohoFailed: true,
      zohoError: prepareData.zohoError || 'Zoho skipped',
      action: 'skipped',
      fieldsSent: {}
    }
  }];
}

// Aggregate results from ALL upsert responses
const zohoResults = [];
let anyFailed = false;
let zohoError = '';
const zohoIds = [];

for (const item of allUpsertItems) {
  const upsertResult = item.json;
  try {
    const responseData = upsertResult.data || [];
    for (const result of responseData) {
      const zohoId = result.details?.id || '';
      const action = result.action || 'unknown';
      const success = result.code === 'SUCCESS';
      if (!success) { anyFailed = true; zohoError += (result.message || result.code) + '; '; }
      if (zohoId) zohoIds.push(zohoId);
      zohoResults.push({ index: zohoResults.length, zohoId, action, success, message: result.message || '' });
    }
  } catch (e) { anyFailed = true; zohoError = e.message; }
}

// v3.32: emit one output item per successful upsert so Fetch Zoho Contact fires per contact
const successResults = zohoResults.filter(r => r.success);
const accessToken = prepareData.accessToken || '';

if (successResults.length === 0) {
  return [{
    json: {
      zohoResults,
      zohoIds,
      action: 'unknown',
      zohoFailed: true,
      zohoError,
      accessToken,
      fetchUrl: '',
      ...prepareData
    }
  }];
}

return successResults.map((r, idx) => ({
  json: {
    zohoResults,
    zohoIds,
    action: r.action || 'unknown',
    zohoFailed: false,
    zohoError,
    accessToken,
    fetchUrl: 'https://www.zohoapis.com/crm/v7/Contacts/' + r.zohoId,
    currentZohoId: r.zohoId,
    currentZohoIndex: idx,
    ...prepareData
  }
}));
