// Format for CSV
//
// Builds three row sets per email, one row per contact: csvRows for the local backup
// CSV, and developerLogRows and zohoImportRows for the two Excel log sheets.
// Input: validated items with contacts[]. Output: the same items plus the row arrays.
// Email-level fields (subject, forwarder note, email_id) come from the item;
// contact fields come from each entry in contacts[], never the top level.

const allItems = $input.all();
const allResults = [];

for (const _item of allItems) {

// Skipped emails pass through untouched.
if (_item.json.skip) {
  allResults.push({ json: _item.json });
  continue;
}

const data = _item.json;

const contacts = data.contacts || [];

// Keep the item even with no contacts so the confirmation can still say so.
if (contacts.length === 0) {
  allResults.push({
    json: {
      ...data,
      csvRow: null,
      csvRows: [],
      developerLogRow: null,
      developerLogRows: [],
      zohoImportRow: null,
      zohoImportRows: [],
      needsReview: data.needsReview || false,
      reviewReason: data.reviewReason || ''
    }
  });
  continue;
}

const clean = (val) => {
  if (val === null || val === undefined) return '';
  return String(val).trim();
};

const formatDateTime = () => {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
};

const processedDate = formatDateTime();

const csvRows = [];
const developerLogRows = [];
const zohoImportRows = [];

for (const contact of contacts) {

  const buildReviewReason = (c) => {
    const reasons = [];
    if (c.typeConflict) reasons.push(`TYPE MISMATCH: ${c.conflictReason || 'hint vs evidence'}`);
    if (c.confidence === 'low') reasons.push('LOW CONFIDENCE');
    if (c.missingCriticalFields && c.missingCriticalFields.length > 0) {
      reasons.push(`MISSING: ${c.missingCriticalFields.join(', ')}`);
    }
    if (!c.email) reasons.push('NO EMAIL');
    if (data.webResearchAttempted && !data.webResearchSucceeded) reasons.push('WEB RESEARCH FAILED');
    return reasons.join(' | ');
  };

  const contactNeedsReview = contact.needsReview || contact.typeConflict ||
    contact.confidence === 'low' || !contact.email;

  // Backup CSV: the human-readable audit trail.
  csvRows.push({
    'Needs Review': contactNeedsReview ? 'YES' : '',
    'Review Reason': contactNeedsReview ? buildReviewReason(contact) : '',
    'Email': clean(contact.email),
    'First Name': clean(contact.firstName),
    'Last Name': clean(contact.lastName),
    'Type': clean(contact.type),
    'Specific Type': clean(contact.specificType),
    'Company Name': clean(contact.companyName),
    'Job Title': clean(contact.jobTitle),
    'Phone': clean(contact.phone),
    'Mobile': clean(contact.mobile),
    'Address': clean(contact.address),
    'City': clean(contact.city),
    'State': clean(contact.state),
    'Country': clean(contact.country),
    'Website': clean(contact.website),
    'Source Subject': clean(data.originalSubject) || '[No subject]',
    'Forwarder Instruction': clean(data.forwarderInstruction) || '[None]',
    'Extraction Confidence': clean(contact.confidence),
    'Type Source': clean(contact.typeSource),
    'Type Validated': contact.typeValidated ? 'YES' : '',
    'Type Corrected': contact.typeCorrected ? 'YES' : '',
    'Skip Zoho': contact.skipZohoUpsert ? 'YES' : '',
    'Web Research': data.webResearchAttempted
      ? (data.webResearchSucceeded ? `Success (${data.pagesVisited || 0} pages)` : 'Failed')
      : 'Not Needed',
    'Date Processed': processedDate,
    'Zip': clean(contact.zip) // last column: an existing CSV keeps the header from its first row
  });

  // Developer log: everything above plus type-resolution metadata.
  developerLogRows.push({
    'Date Processed': processedDate,
    'Email': clean(contact.email),
    'First Name': clean(contact.firstName),
    'Last Name': clean(contact.lastName),
    'Type': clean(contact.type),
    'Specific Type': clean(contact.specificType),
    'Company Name': clean(contact.companyName),
    'Job Title': clean(contact.jobTitle),
    'Phone': clean(contact.phone),
    'Mobile': clean(contact.mobile),
    'Address': clean(contact.address),
    'City': clean(contact.city),
    'State': clean(contact.state),
    'Country': clean(contact.country),
    'Website': clean(contact.website),
    'Source Subject': clean(data.originalSubject) || '[No subject]',
    'Forwarder Instruction': clean(data.forwarderInstruction) || '[None]',
    'Extraction Confidence': clean(contact.confidence),
    'Type Source': clean(contact.typeSource),
    'Type Validated': contact.typeValidated ? 'YES' : '',
    'Type Corrected': contact.typeCorrected ? 'YES' : '',
    'Original Extracted Type': clean(contact.originalExtractedType),
    'AI Extracted Type': clean(contact.aiExtractedType),
    'Type Conflict': contact.typeConflict ? 'YES' : '',
    'Conflict Reason': clean(contact.conflictReason),
    'Inferred Company Type': clean(contact.inferredCompanyType),
    'Inferred Type Confidence': clean(contact.inferredTypeConfidence),
    'Inferred Type Source': clean(contact.inferredTypeSource),
    'Needs Review': contactNeedsReview ? 'YES' : '',
    'Review Reason': contactNeedsReview ? buildReviewReason(contact) : '',
    'Skip Zoho': contact.skipZohoUpsert ? 'YES' : '',
    'Web Research': data.webResearchAttempted
      ? (data.webResearchSucceeded ? `Success (${data.pagesVisited || 0} pages)` : 'Failed')
      : 'Not Needed',
    'Pages Visited': data.pagesVisited || 0,
    'Email ID': clean(data.email_id),
    'Thread ID': clean(data.thread_id),
    'Forwarder': clean(data.forwarderEmail),
    'Zip': clean(contact.zip)
  });

  // Zoho log: column names match Zoho's import fields so the sheet can be re-imported.
  zohoImportRows.push({
    'Email': clean(contact.email),
    'First_Name': clean(contact.firstName),
    'Last_Name': clean(contact.lastName) || 'Unknown',
    'Title': clean(contact.jobTitle),
    'Phone': clean(contact.phone),
    'Mobile': clean(contact.mobile),
    'Mailing_Street': clean(contact.address),
    'Mailing_City': clean(contact.city),
    'Mailing_State': clean(contact.state),
    'Mailing_Country': clean(contact.country) ,
    'Account_Name': clean(contact.companyName),
    'Type': clean(contact.type),
    'Specific_Type': clean(contact.specificType),
    'Mailing_Zip': clean(contact.zip) // log only; Prepare Upsert does not send zip to Zoho
  });
}

// The singular *Row fields hold the first contact for the log-row nodes that read one row.
allResults.push({
  json: {
    ...data,
    csvRow: csvRows[0] || null,
    csvRows: csvRows,
    developerLogRow: developerLogRows[0] || null,
    developerLogRows: developerLogRows,
    zohoImportRow: zohoImportRows[0] || null,
    zohoImportRows: zohoImportRows,
    needsReview: contacts.some(c => c.needsReview),
    reviewReason: contacts.filter(c => c.needsReview).map(c => {
      const reasons = [];
      if (c.typeConflict) reasons.push('TYPE MISMATCH');
      if (c.confidence === 'low') reasons.push('LOW CONFIDENCE');
      if (!c.email) reasons.push('NO EMAIL');
      return `[${c.email || 'no-email'}] ${reasons.join(', ')}`;
    }).join(' || ')
  }
});

}

return allResults;
