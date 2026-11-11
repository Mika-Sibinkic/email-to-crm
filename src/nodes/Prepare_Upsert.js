// Prepare Upsert
//
// Builds one Zoho upsert request per contact. Zoho rejects a whole batch if any
// record is bad, so single-record upserts keep one bad contact from blocking the
// others. Email is the dedup key. Fields that validation cleared are never sent,
// because Zoho only overwrites fields present in the request. Account_Name is a
// lookup field and Zoho resolves a plain company name. Type and Specific_Type are
// multi-select picklists, so they go as arrays.
//
// Input: the Zoho token response, plus every Save to CSV item (one per email).
// Output: one item per upsertable contact with upsertBody; one skipped item per
// email when nothing can be sent.

if ($input.first().json.skip) {
  return [{ json: $input.first().json }];
}
const tokenResponse = $input.first().json;
// A failed token refresh still yields an item; the per-email check below turns it
// into a CSV-only result instead of a crash.
if (!tokenResponse.access_token) {
  console.log('WARNING: Zoho token refresh returned no access_token');
}

const accessToken = tokenResponse.access_token;

// One token serves every email in the poll; each Save to CSV item is one email.
const allCsvItems = $('Save to CSV').all();
const allOutputItems = [];

for (let _emailIdx = 0; _emailIdx < allCsvItems.length; _emailIdx++) {
const contactData = allCsvItems[_emailIdx].json;

if (contactData.skip) {
  allOutputItems.push({ json: contactData });
  continue;
}

const contacts = contactData.contacts || [];

if (contactData.skipZohoUpsert || contacts.length === 0) {
  allOutputItems.push({
    json: {
      ...contactData,
      zohoSkipped: true,
      zohoError: 'No contacts to upsert',
      upsertBody: null,
      accessToken: null
    }
  });
  continue;
}

if (!accessToken) {
  allOutputItems.push({
    json: {
      ...contactData,
      zohoSkipped: true,
      zohoError: 'Token refresh failed - contacts saved to CSV only',
      zohoFailed: true,
      upsertBody: null,
      accessToken: null
    }
  });
  continue;
}

// Edit to match your CRM's contact-type picklist.
// Maps the pipeline's type names to Zoho picklist values; identical unless your
// picklist labels differ.
const ZOHO_TYPE_MAP = {
  "Attorney": "Attorney",
  "Broker": "Broker",
  "Customer": "Customer",
  "Employee": "Employee",
  "Family Office": "Family Office",
  "Financial Institution": "Financial Institution",
  "Industry Resource": "Industry Resource",
  "Insurance": "Insurance",
  "Investment Advisor": "Investment Advisor",
  "Management Company": "Management Company",
  "Manufacturer": "Manufacturer",
  "Marketing": "Marketing",
  "Partner": "Partner",
  "Service Provider": "Service Provider"
};

const translateType = (displayType) => {
  if (!displayType) return '';
  return ZOHO_TYPE_MAP[displayType] || displayType;
};

const safeString = (val) => {
  const s = String(val || '').trim();
  return s === '' || s === 'undefined' || s === 'null' || s === '...' ? '' : s;
};

const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const outputItems = [];
const allContactsForConfirmation = [];

for (const contact of contacts) {
  // Skipped contacts still go into the confirmation list so the reply can explain why.
  if (contact.skipZohoUpsert) {
    allContactsForConfirmation.push({
      ...contact,
      zohoSkipped: true,
      skipReason: 'Blocked by validation: ' + (contact.infoNotes || []).join('; ')
    });
    continue;
  }

  // A contact with only an inferred email (from the company's address pattern) is
  // still worth saving; it goes in flagged for review and the confirmation asks the
  // user to verify it.
  if (!contact.email && contact.inferredEmail) {
    contact.email = contact.inferredEmail;
    contact.needsReview = true;
    if (!contact.reviewReasons) contact.reviewReasons = [];
    contact.reviewReasons.push('INFERRED EMAIL: ' + contact.inferredEmail + ' — please verify this is correct');
    if (!contact.infoNotes) contact.infoNotes = [];
    contact.infoNotes.push('Email inferred from company domain pattern, not found in source text');
  }

  // Without an email Zoho cannot dedup, so every rerun would create a duplicate.
  const email = safeString(contact.email);
  if (!email) {
    allContactsForConfirmation.push({
      ...contact,
      zohoSkipped: true,
      skipReason: 'No email — cannot deduplicate in Zoho (would create duplicate)'
    });
    continue;
  }

  if (!emailRegex.test(email)) {
    allContactsForConfirmation.push({
      ...contact,
      zohoSkipped: true,
      skipReason: 'Invalid email format: "' + email + '"'
    });
    continue;
  }

  // Omitting a field preserves whatever Zoho already holds, so empty or cleared
  // values are left out rather than sent as blanks.
  const record = {};
  const clearedFieldNames = new Set(
    (contact.clearedFields || []).map(f => typeof f === 'string' ? f : f.field)
  );

  record.Email = email;

  // Zoho requires Last_Name on create, but a guessed value is worse than a rejected record.
  const lastName = safeString(contact.lastName);
  if (lastName && !clearedFieldNames.has('lastName')) {
    record.Last_Name = lastName;
  }

  const firstName = safeString(contact.firstName);
  if (firstName && !clearedFieldNames.has('firstName')) {
    record.First_Name = firstName;
  }

  const optionalFieldMap = {
    Title:           { value: safeString(contact.jobTitle),    cleared: 'jobTitle' },
    Phone:           { value: safeString(contact.phone),       cleared: 'phone' },
    Mobile:          { value: safeString(contact.mobile),      cleared: 'mobile' },
    Mailing_Street:  { value: safeString(contact.address),     cleared: 'address' },
    Mailing_City:    { value: safeString(contact.city),        cleared: 'city' },
    Mailing_State:   { value: safeString(contact.state),       cleared: 'state' },
    Account_Name:    { value: safeString(contact.companyName), cleared: 'companyName' }
  };

  for (const [zohoField, info] of Object.entries(optionalFieldMap)) {
    if (info.value && !clearedFieldNames.has(info.cleared)) {
      record[zohoField] = info.value;
    }
  }

  const country = safeString(contact.country);
  if (country) {
    record.Mailing_Country = country;
  }

  // The Description stamp is how you can tell later that a record came from this pipeline.
  record.Description = 'Auto-imported via Email-to-CRM on ' +
    new Date().toLocaleString('en-US', {timeZone: 'America/New_York'}) +
    '. Source: ' + (contactData.originalSubject || 'N/A') +
    '. Confidence: ' + (contact.confidence || 'N/A') +
    '. Verification: ' + (contact.verificationScore !== undefined ? contact.verificationScore + '%' : 'N/A') +
    '.' + (contact.needsReview ? ' ⚠️ NEEDS REVIEW.' : '');

  const translatedType = translateType(contact.type);
  if (translatedType) record.Type = [translatedType];

  const specificType = safeString(contact.specificType);
  if (specificType) record.Specific_Type = [specificType];

  allContactsForConfirmation.push({ ...contact, zohoSkipped: false });

  outputItems.push({
    json: {
      accessToken: accessToken,
      upsertBody: {
        data: [record],
        duplicate_check_fields: ['Email'],
        trigger: ['workflow']
      },
      zohoSkipped: false,
      zohoFailed: false,
      zohoError: '',
      contactEmail: email,
      contactName: ((firstName || '') + ' ' + (lastName || '')).trim(),
      contacts: allContactsForConfirmation,
      contactCount: contacts.length,
      ...contactData
    }
  });
}

// If every contact was skipped, still emit one item so the confirmation runs.
if (outputItems.length === 0) {
  allOutputItems.push({
    json: {
      accessToken: null,
      upsertBody: null,
      zohoSkipped: true,
      zohoFailed: false,
      zohoError: 'All contacts skipped — see individual skip reasons',
      contacts: allContactsForConfirmation,
      contactCount: allContactsForConfirmation.length,
      recordCount: 0,
      skippedContacts: allContactsForConfirmation.filter(c => c.zohoSkipped),
      skippedCount: allContactsForConfirmation.filter(c => c.zohoSkipped).length,
      ...contactData
    }
  });
} else {
  // Only the last item has seen every contact, so it carries the full list and counts.
  outputItems[outputItems.length - 1].json.contacts = allContactsForConfirmation;
  outputItems[outputItems.length - 1].json.recordCount = outputItems.length;
  outputItems[outputItems.length - 1].json.skippedContacts = allContactsForConfirmation.filter(c => c.zohoSkipped);
  outputItems[outputItems.length - 1].json.skippedCount = allContactsForConfirmation.filter(c => c.zohoSkipped).length;

  for (const oi of outputItems) { allOutputItems.push(oi); }
}

}

return allOutputItems;
