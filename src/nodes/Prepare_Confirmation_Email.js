// Prepare Confirmation Email
//
// Builds one confirmation per email in the poll. Each contact gets a card with every
// field Zoho now holds (from Fetch Zoho Contact, falling back to the extracted
// values), any warnings, and a signed 24-hour undo link. Contacts built from
// fragments or with low confidence are marked as needing a check.
//
// Input: Format for CSV items (one per email), plus Upsert Contact and Fetch Zoho
// Contact results. Output: { emailSubject, emailBody, forwarderEmail, zohoIds,
// undoLink, ... } per email, or a skipEmail item when there is nothing to send.

// Organization settings
const SUBJECT_TAG = '[CRM]';

function buildContactCard(contact, zohoRecord, upsertResult, contactNum, totalContacts) {
  const c = contact;
  const z = zohoRecord || {};
  const r = upsertResult || {};
  const hasZoho = Object.keys(z).length > 0;
  const isSkipped = c.skipZohoUpsert;

  let action = 'UNKNOWN';
  if (isSkipped) {
    action = 'SKIPPED';
  } else if (!r.success && !isSkipped) {
    action = 'FAILED';
  } else {
    action = r.action === 'update' ? 'UPDATED' : 'ADDED';
  }

  const icon = action === 'ADDED' ? '✅' : action === 'UPDATED' ? '✅' : action === 'SKIPPED' ? '⏭️' : '🚨';
  const reviewFlag = c.needsReview ? ' ⚠️ NEEDS REVIEW' : '';
  const name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || 'Unknown';

  let card = '';
  if (totalContacts > 1) {
    card += '━━━ Contact ' + contactNum + ' of ' + totalContacts + ' ━━━\n';
  }
  card += icon + ' ' + action + ': ' + name + reviewFlag + '\n';

  if (c.needsReview && c.reviewReason) {
    card += '→ ' + c.reviewReason + '\n';
  }
  if (c.reviewReasons && c.reviewReasons.length > 0) {
    for (const rr of c.reviewReasons) {
      card += '→ ' + rr + '\n';
    }
  }
  card += '\n';

  if (action === 'FAILED') {
    card += 'Zoho sync failed. Contact saved to backup CSV log.\n';
    return card;
  }

  if (isSkipped) {
    const skipNote = (c.infoNotes || []).find(n => n.includes('skipped') || n.includes('not the intended'));
    if (skipNote) card += 'Reason: ' + skipNote + '\n';
    return card;
  }

  // Prefer what Zoho now holds; the extracted value fills in when the fetch failed.
  const accountName = hasZoho && z.Account_Name
    ? (typeof z.Account_Name === 'object' ? z.Account_Name.name : z.Account_Name)
    : c.companyName || c.company || '';

  const zohoType = hasZoho && z.Type
    ? (Array.isArray(z.Type) ? z.Type.join(', ') : z.Type)
    : c.type || '';

  const fields = [
    ['First Name',  hasZoho ? z.First_Name : c.firstName],
    ['Last Name',   hasZoho ? z.Last_Name : c.lastName],
    ['Email',       hasZoho ? z.Email : c.email],
    ['Phone',       hasZoho ? z.Phone : c.phone],
    ['Mobile',      hasZoho ? z.Mobile : c.mobile],
    ['Job Title',   hasZoho ? z.Title : c.jobTitle || c.title],
    ['Company',     accountName],
    ['Type',        zohoType],
    ['Specific Type', c.specificType],
    ['Website',     c.website || ''],
    ['Address',     hasZoho ? z.Mailing_Street : c.address],
    ['City',        hasZoho ? z.Mailing_City : c.city],
    ['State',       hasZoho ? z.Mailing_State : c.state],
    ['Country',     hasZoho ? z.Mailing_Country : c.country],
    ['Zip',         hasZoho ? z.Mailing_Zip : ''],
    ['Description', hasZoho ? (z.Description || '').substring(0, 200) : ''],
  ];

  if (hasZoho) {
    fields.push(
      ['Zoho ID',      z.id],
      ['Created',      z.Created_Time ? z.Created_Time.substring(0, 19).replace('T', ' ') : ''],
      ['Modified',     z.Modified_Time ? z.Modified_Time.substring(0, 19).replace('T', ' ') : ''],
      ['Owner',        z.Owner ? (typeof z.Owner === 'object' ? z.Owner.name : z.Owner) : ''],
    );
  }

  card += 'Zoho Record:\n';
  for (const [label, val] of fields) {
    if (val !== undefined && val !== null && val !== '' && val !== false) {
      card += '  ' + label + ': ' + val + '\n';
    }
  }

  const allNotes = c.infoNotes || [];
  if (allNotes.length > 0) {
    card += '\nNotes: ' + allNotes.join('; ') + '\n';
  }
  if (c.extractionMethod) {
    card += 'Extraction: ' + c.extractionMethod + ' | Confidence: ' + (c.confidence || '?') + '\n';
  }

  // Stub and low-confidence contacts have fields from web research, not the email.
  if (c.extractionMethod === 'STUB_FROM_FRAGMENTS' || c.confidence === 'low') {
    card += '\n⚠️ Some fields were inferred via web research and may need verification\n';
    if (c.missingFields && c.missingFields.length > 0) {
      card += 'Missing fields: ' + c.missingFields.join(', ') + '\n';
    }
  }
  if (c.inferredEmail) {
    card += '⚠️ Email inferred from company domain pattern — please verify: ' + c.inferredEmail + '\n';
    if (c.inferredEmails && c.inferredEmails.length > 1) {
      card += '   Other candidates: ' + c.inferredEmails.slice(1, 4).join(', ') + '\n';
    }
  }

  return card;
}

const allInputItems = $input.all();
const skipItems = allInputItems.filter(i => i.json.skip);
const results = [];

// Skipped emails get a skipEmail item instead of a reply.
for (const si of skipItems) {
  results.push({ json: { skipEmail: true, reason: si.json.skipReason || 'SKIPPED', emailSubject: '', emailBody: '' } });
}

let allEmails = [];
try { allEmails = $('Format for CSV').all(); } catch(e) { allEmails = []; }

if (allEmails.length === 0) {
  // Format for CSV did not run in this execution; fall back to the input item.
  const nonSkip = allInputItems.filter(i => !i.json.skip);
  if (nonSkip.length > 0) {
    allEmails = [{ json: nonSkip[nonSkip.length - 1].json }];
  }
}

let allUpsertData = [];
try {
  const upsertItems = $('Upsert Contact').all();
  for (const item of upsertItems) {
    const u = item.json;
    if (u.data && Array.isArray(u.data)) {
      for (const r of u.data) {
        allUpsertData.push({
          zohoId: r.details?.id || '',
          action: r.action || 'unknown',
          success: r.code === 'SUCCESS',
          message: r.message || '',
          email: r.details?.Modified_By ? '' : ''
        });
      }
    }
  }
} catch(e) {}

let allFetchData = [];
try {
  const fetchItems = $('Fetch Zoho Contact').all();
  for (const item of fetchItems) {
    if (item.json.data && item.json.data[0]) {
      allFetchData.push(item.json.data[0]);
    }
  }
} catch(e) {}

// Upsert results arrive as one flat list in email order, so a running index splits
// them back per email.
let upsertIdx = 0;

for (let emailIdx = 0; emailIdx < allEmails.length; emailIdx++) {
  const contactData = allEmails[emailIdx].json;
  const contacts = contactData.contacts || [];
  const detectionFlags = contactData.detectionFlags || [];
  const zohoSkipped = contactData.skipZohoUpsert || false;

  const upsertableContacts = contacts.filter(c => !c.skipZohoUpsert);
  const emailUpsertResults = [];
  const emailZohoIds = [];

  if (!zohoSkipped) {
    for (let i = 0; i < upsertableContacts.length; i++) {
      if (upsertIdx < allUpsertData.length) {
        emailUpsertResults.push(allUpsertData[upsertIdx]);
        if (allUpsertData[upsertIdx].zohoId) {
          emailZohoIds.push(allUpsertData[upsertIdx].zohoId);
        }
        upsertIdx++;
      }
    }
  }

  const zohoFailed = !zohoSkipped && upsertableContacts.length > 0 && emailUpsertResults.length === 0;
  const tokenFailed = false;

  let undoLink = '';
  if (emailZohoIds.length > 0) {
    const crypto = require('crypto');
    // Set UNDO_SECRET in the n8n environment; never commit it.
    const UNDO_SECRET = $env.UNDO_SECRET;
    // Set WEBHOOK_BASE_URL to the public n8n host. The try-catch is there because
    // some n8n setups block $env access in Code nodes.
    let baseUrl = 'https://n8n.example.internal';
    try { if (typeof $env !== 'undefined' && $env.WEBHOOK_BASE_URL) baseUrl = $env.WEBHOOK_BASE_URL; } catch(e) {}
    const payload = JSON.stringify({
      zohoIds: emailZohoIds,
      emails: contacts.map(c => c.email).filter(Boolean),
      timestamp: Date.now(),
      expires: Date.now() + (24 * 60 * 60 * 1000)
    });
    const signature = crypto.createHmac('sha256', UNDO_SECRET).update(payload).digest('hex');
    const signedToken = Buffer.from(JSON.stringify({ payload, sig: signature })).toString('base64');
    undoLink = baseUrl + '/webhook/undo-contact?token=' + encodeURIComponent(signedToken);
  }

  let emailBody = '';
  let emailSubject = '';

  if (contacts.length === 0) {
    // Names found without emails are still shown so the user can follow up by hand.
    const partials = contactData.partialFindings || [];
    const scrapedUrl = contactData.primaryUrl || '';

    emailSubject = SUBJECT_TAG + ' No Contact Found';
    emailBody = '⏭️ No extractable contact found\n\n' +
      'Source: ' + (contactData.originalSubject || 'N/A') + '\n\n' +
      'The system could not find a complete contact (with email) in this email.\n' +
      'No Zoho record was created.\n' +
      (detectionFlags.length > 0 ? 'Detected: ' + detectionFlags.join(', ') + '\n' : '') +
      (function() {
        const requestedType = contactData.forwarderInstruction || contactData.suggestedType || '';
        return requestedType ? '\nRequested type: "' + requestedType + '"' : '';
      })();

    if (partials.length > 0) {
      emailBody += '\n\n━━━ Partial Data Found (no emails on page) ━━━\n';
      if (scrapedUrl) emailBody += 'Page scraped: ' + scrapedUrl + '\n\n';
      emailBody += 'The following names were found but no email addresses were listed:\n\n';
      for (let i = 0; i < partials.length && i < 20; i++) {
        const p = partials[i];
        emailBody += '  ' + (i + 1) + '. ' + p.name;
        if (p.phone) emailBody += ' — ' + p.phone;
        if (p.title) emailBody += ' (' + p.title + ')';
        emailBody += '\n';
      }
      emailBody += '\nTo add these contacts, reply to their company directly to get email addresses,\nthen forward the reply to this inbox.\n';
    } else {
      emailBody += '\n\nIf there IS a contact here that the system missed, please forward again with contact details in the email body text.\n';
    }

    emailBody += '\n---\nEmail-to-CRM';

  } else if (zohoFailed) {
    emailSubject = SUBJECT_TAG + ' Zoho sync failed — contacts saved to log';
    emailBody = '🚨 Zoho sync failed — contacts saved to backup log\n\n' +
      'Source: ' + (contactData.originalSubject || 'N/A') + '\n' +
      'Cause: Zoho authentication token refresh failed\n\n' +
      'Extracted ' + contacts.length + ' contact(s) but could not sync to Zoho CRM.\n' +
      'They have been saved to the backup CSV log for manual import.\n\n';
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || 'Unknown';
      emailBody += '  ' + (i+1) + '. ' + name + ' — ' + (c.email || 'no email') + ' (' + (c.type || 'N/A') + ')\n';
    }
    emailBody += '\n---\nEmail-to-CRM';

  } else {
    const upsertedCount = emailUpsertResults.filter(r => r.success).length;
    const skippedCount = contacts.filter(c => c.skipZohoUpsert).length;
    const reviewCount = contacts.filter(c => c.needsReview).length;

    const primaryName = ((contacts[0].firstName || '') + ' ' + (contacts[0].lastName || '')).trim() || 'Unknown';
    if (contacts.length === 1) {
      const r0 = emailUpsertResults[0] || {};
      const c0 = contacts[0];
      const act = c0.skipZohoUpsert ? 'Skipped' : (!r0.success ? 'Error' : r0.action === 'update' ? 'Updated' : 'Added');
      emailSubject = SUBJECT_TAG + ' ' + act + ' 1 contact: ' + primaryName;
    } else {
      emailSubject = SUBJECT_TAG + ' ' + (upsertedCount > 0 ? upsertedCount + ' contact(s) added/updated' : 'Processed') +
        (skippedCount > 0 ? ', ' + skippedCount + ' skipped' : '') +
        ': ' + primaryName + (contacts.length > 1 ? ' +' + (contacts.length - 1) : '');
    }

    emailBody = 'Source: ' + (contactData.originalSubject || 'N/A') + '\n';
    emailBody += contacts.length + ' contact(s) extracted\n\n';

    // Skipped contacts have no upsert result, so the upsert pointer advances only on
    // upserted ones.
    let upsertPointer = 0;
    let fetchPointer = 0;

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const isSkipped = c.skipZohoUpsert;

      let upsertResult = {};
      if (!isSkipped && upsertPointer < emailUpsertResults.length) {
        upsertResult = emailUpsertResults[upsertPointer];
        upsertPointer++;
      }

      let contactZoho = {};
      const thisZohoId = upsertResult.zohoId || '';
      if (thisZohoId) {
        for (const fd of allFetchData) {
          if (fd.id === thisZohoId) { contactZoho = fd; break; }
        }
      }
      // No fetch record matched by Zoho ID; fall back to position.
      if (Object.keys(contactZoho).length === 0 && fetchPointer < allFetchData.length) {
        contactZoho = allFetchData[fetchPointer];
        fetchPointer++;
      }

      emailBody += buildContactCard(c, contactZoho, upsertResult, i + 1, contacts.length);
      emailBody += '\n';
    }

    if (reviewCount > 0) {
      emailBody += reviewCount + ' contact(s) need manual review.\n';
    }

    if (undoLink) {
      emailBody += '\nUndo this update (expires in 24hrs): ' + undoLink + '\n';
    }

    emailBody += '\n---\nEmail-to-CRM';
  }

  results.push({
    json: {
      emailBody,
      emailSubject,
      forwarderEmail: contactData.forwarderEmail || '',
      zohoIds: emailZohoIds,
      undoLink,
      zohoFailed: zohoFailed || tokenFailed,
      zohoSkipped,
      contactCount: contacts.length
    }
  });
}

// Always emit at least one item so downstream nodes see an explicit skip.
if (results.length === 0) {
  results.push({ json: { skipEmail: true, reason: 'NO_EMAILS', emailSubject: '', emailBody: '' } });
}

return results;