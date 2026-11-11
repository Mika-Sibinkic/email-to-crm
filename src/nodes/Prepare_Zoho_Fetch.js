// Prepare Zoho Fetch
//
// Emits one item per successful upsert, each with its own fetchUrl, so Fetch Zoho
// Contact runs once per contact and Prepare Confirmation Email can match records by
// Zoho ID. With a single fetch, a multi-contact email showed the first contact's
// CRM data on every card.
//
// Input: the Upsert Contact responses, plus Prepare Upsert's last item for context.
// Output: one item per successful upsert, or one skipped/failed item if none.

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

// Collect every upsert response; one contact per request means one response per contact.
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
