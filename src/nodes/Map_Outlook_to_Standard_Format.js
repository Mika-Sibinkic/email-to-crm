// Map Outlook to Standard Format
//
// First node after the Outlook trigger. Turns each Microsoft Graph message into the
// flat shape the rest of the workflow reads, and rejects mail that must never be
// extracted: drafts and Sent Items copies, duplicates, the intake mailbox's own
// mail, auto-replies, unsolicited outside mail, bounces, the workflow's own
// confirmations, and blank bodies. A rejected email becomes { skip: true,
// skipReason } and every downstream node passes it through untouched.
//
// It also strips HTML to text, flags image and PDF attachments (including inline
// CID photos such as business cards), and normalizes entities, invisible characters,
// odd spaces and Unicode dashes once here so later regexes only see plain text.
//
// Input: Graph message items from the trigger.
// Output: { email_id, thread_id, subject, body, rawHtml, received_date,
// forwarderEmail, forwarderName, hasAttachments, attachmentHints, source } or a skip item.

// Organization settings
const OWN_DOMAINS = new Set(['yourcompany.com']);
const OWN_STAFF = [
  { name: 'Pat Staffer', email: 'pat@yourcompany.com', title: 'Managing Director' },
  { name: 'Alex Example', email: 'alex@yourcompany.com', title: 'Associate' }
];
const INTAKE_ADDRESS = 'contacts@yourcompany.com';
const SUBJECT_TAG = '[CRM]';
// Outside addresses allowed to send requests, e.g. a staff member's personal mailbox.
const KNOWN_FORWARDERS = new Set([]);

// The trigger polls every folder, so a message the intake mailbox sends to itself shows up in
// Sent Items as well as the Inbox. Folder IDs are fixed per mailbox: read them once from
// GET /users/<intake mailbox>/mailFolders/sentitems and /drafts and paste them here.
const SENT_ITEMS_FOLDER_ID = '<sent-items-folder-id>';
const DRAFTS_FOLDER_ID = '<drafts-folder-id>';

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SUBJECT_TAG_RE = escapeRe(SUBJECT_TAG.toLowerCase());
const OWN_DOMAIN_RE = [...OWN_DOMAINS].map(escapeRe).join('|');

const allItems = $input.all();
const results = [];
const seenInternetIds = new Set();

for (const item of allItems) {
  const email = item.json;

  const senderAddress = (email.from?.emailAddress?.address || '').toLowerCase();
  const rawSubject = (email.subject || '').toLowerCase();

  // Only the Inbox copy is processed; the others would upsert the same contact twice.
  if (email.isDraft === true || email.parentFolderId === DRAFTS_FOLDER_ID) {
    results.push({ json: { skip: true, skipReason: 'DRAFT', email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }
  if (email.parentFolderId === SENT_ITEMS_FOLDER_ID) {
    results.push({ json: { skip: true, skipReason: 'SENT_ITEMS_COPY', email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }
  if (email.internetMessageId) {
    if (seenInternetIds.has(email.internetMessageId)) {
      results.push({ json: { skip: true, skipReason: 'DUPLICATE_COPY: ' + email.internetMessageId, email_id: email.id || '', subject: email.subject || '' } });
      continue;
    }
    seenInternetIds.add(email.internetMessageId);
  }

  // Mail from the intake mailbox is usually the workflow's own output; processing it would loop.
  if (senderAddress === INTAKE_ADDRESS) {
    // A human can bounce a request through a personal mailbox and back: the From header still
    // shows the intake address, but the body carries the forward headers.
    const bodySnippet = (email.body?.content || email.bodyPreview || '').substring(0, 3000);
    const reforwardSenders = [...KNOWN_FORWARDERS, ...OWN_STAFF.map(s => s.email)];
    const isHumanReforward = /---------- Forwarded message/i.test(bodySnippet) ||
      reforwardSenders.some(a => new RegExp('From:.*' + escapeRe(a), 'i').test(bodySnippet));

    // Confirmations carry the subject tag; a RE:/FW: of one is still not a request.
    const isSystemEmail = new RegExp('^(?:(?:re|fw|fwd)\\s*:\\s*)*' + SUBJECT_TAG_RE, 'i').test((email.subject || ''));

    // A request typed inside the intake mailbox and addressed to itself is a real request.
    const recipients = [...(email.toRecipients || []), ...(email.ccRecipients || [])]
      .map(r => (r.emailAddress?.address || '').toLowerCase());
    const isSelfAddressedRequest = recipients.includes(INTAKE_ADDRESS);

    if (!(isHumanReforward || isSelfAddressedRequest) || isSystemEmail) {
      results.push({ json: { skip: true, skipReason: 'SELF_SENT: from contacts@ inbox', email_id: email.id || '', subject: email.subject || '' } });
      continue;
    }
  }

  // Auto-replies and out-of-office notices.
  const autoReplyPatterns = [
    /out\s+of\s+(the\s+)?office/i,
    /automatic\s+reply/i,
    /auto[\s-]?reply/i,
    /auto[\s-]?response/i,
    /auto[\s-]?generated/i,
    /do\s+not\s+reply/i,
    /this\s+is\s+an?\s+automated/i
  ];
  const isAutoReply = autoReplyPatterns.some(p => p.test(rawSubject)) ||
    (email.internetMessageHeaders || []).some(h =>
      h.name?.toLowerCase() === 'auto-submitted' && h.value !== 'no'
    );
  if (isAutoReply) {
    results.push({ json: { skip: true, skipReason: 'AUTO_REPLY: ' + rawSubject, email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }

  // Newsletters and cold outreach sent straight to the intake address are not requests.
  const senderDomain = senderAddress.split('@')[1] || '';
  const isOwnSender = OWN_DOMAINS.has(senderDomain);
  const isKnownForwarder = KNOWN_FORWARDERS.has(senderAddress);

  if (!isOwnSender && !isKnownForwarder) {
    // Unless the body shows staff forwarded it from somewhere else.
    const bodyText = (email.body?.content || email.bodyPreview || '').substring(0, 2000);
    const hasForwardIndicator = new RegExp('---------- Forwarded message|Begin forwarded message|From:.*@(?:' + OWN_DOMAIN_RE + ')', 'i').test(bodyText);
    if (!hasForwardIndicator) {
      results.push({ json: { skip: true, skipReason: 'UNSOLICITED: external sender ' + senderAddress + ' (not forwarded by staff)', email_id: email.id || '', subject: email.subject || '' } });
      continue;
    }
  }

  // Bounces and delivery failures.
  const bouncePatterns = [
    /delivery\s+(status|failure|has\s+failed)/i,
    /undeliverable/i,
    /mail\s+delivery\s+(failed|subsystem)/i,
    /mailer[\s-]?daemon/i,
    /returned\s+mail/i,
    /failure\s+notice/i
  ];
  const isBounce = bouncePatterns.some(p => p.test(rawSubject)) ||
    senderAddress.includes('mailer-daemon') ||
    senderAddress.includes('postmaster@');
  if (isBounce) {
    results.push({ json: { skip: true, skipReason: 'BOUNCE: ' + rawSubject, email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }

  // The workflow's own confirmations ("[CRM] Upserted 1 contact: Jane Doe"); see Prepare Confirmation Email.
  if (new RegExp('^' + SUBJECT_TAG_RE).test(rawSubject) ||
      /^\[contact\s+extractor\]/i.test(rawSubject) ||
      /^✅\s*(contact|extraction|processed)/i.test(rawSubject)) {
    results.push({ json: { skip: true, skipReason: 'OWN_CONFIRMATION: ' + rawSubject, email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }

  // Attachment hints tell Email Parser which extraction strategy to pick.
  let attachmentHints = [];
  if (email.hasAttachments) {
    const atts = email.attachments || [];
    for (const att of atts) {
      const name = (att.name || '').toLowerCase();
      const ctype = (att.contentType || '').toLowerCase();
      if (/\.(png|jpg|jpeg|gif|bmp|tiff|webp|heic)$/.test(name) || ctype.startsWith('image/')) {
        if (!attachmentHints.includes('IMAGE')) attachmentHints.push('IMAGE');
      }
      if (/\.pdf$/.test(name) || ctype === 'application/pdf') {
        if (!attachmentHints.includes('PDF')) attachmentHints.push('PDF');
      }
    }
  }

  // Graph returns either HTML or plain text.
  let bodyText = '';
  if (email.body) {
    bodyText = email.body.content || '';
    // A basic strip is enough: the model and the regexes only need readable lines.
    if (email.body.contentType === 'html' || email.body.contentType === 'HTML') {
      // Look for inline CID images before stripping them: phone forwards embed business card
      // photos this way and Graph reports hasAttachments=false for them.
      const cidImageTags = bodyText.match(/<img[^>]*src\s*=\s*["']cid:[^"']*["'][^>]*>/gi) || [];
      for (const tag of cidImageTags) {
        const altMatch = tag.match(/alt\s*=\s*["']([^"']+)["']/i);
        const alt = altMatch ? altMatch[1] : '';
        // Camera photos have alt text like IMG_1234.jpeg or DSC_; signature icons have none or "logo".
        if (/^(IMG_|DSC_|Photo|image|pic)/i.test(alt) || /\.(jpe?g|png|heic)$/i.test(alt)) {
          if (!attachmentHints.includes('IMAGE')) attachmentHints.push('IMAGE');
        }
      }
      // Many inline images with one wider than 100px usually means a real picture among
      // the signature icons (social buttons and logos are small).
      if (cidImageTags.length >= 4 && !attachmentHints.includes('IMAGE')) {
        const hasLargeImage = cidImageTags.some(tag => {
          const wMatch = tag.match(/width\s*=\s*["']?(\d+)/i);
          const w = wMatch ? parseInt(wMatch[1]) : 0;
          const altM = tag.match(/alt\s*=\s*["']([^"']+)["']/i);
          const a = altM ? altM[1].toLowerCase() : '';
          const isBrandIcon = /^(facebook|linkedin|instagram|twitter|youtube|your\s*company|logo|icon)/i.test(a);
          return w > 100 && !isBrandIcon;
        });
        if (hasLargeImage) {
          attachmentHints.push('IMAGE');
        }
      }
      
      bodyText = bodyText
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<img[^>]*src\s*=\s*["']cid:[^"']*["'][^>]*>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        // Table signatures: rows become lines, cells are separated by a space.
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/t[dh]>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  } else if (email.bodyPreview) {
    bodyText = email.bodyPreview;
  }

  // Normalize once here so downstream regexes see plain characters. Word signatures write
  // phones with non-breaking hyphens, which source validation would otherwise reject.
  bodyText = bodyText
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\r\n?/g, '\n')        // plain-text bodies arrive with CRLF
    .replace(/[ \t]+/g, ' ')          // tabs + doubled spaces broke name and label regexes
    .replace(/[ \t]+\n/g, '\n');

  // Blank body with nothing attached: nothing to extract. Checked after stripping, since
  // an HTML body can look non-empty and turn out to be only markup.
  const strippedBody = bodyText.replace(/\s+/g, ' ').trim();
  if (strippedBody.length < 20 && !email.hasAttachments && !attachmentHints.includes('IMAGE')) {
    results.push({ json: { skip: true, skipReason: 'BLANK_BODY: body too short (' + strippedBody.length + ' chars), no attachments', email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }

  results.push({
    json: {
      email_id: email.id || '',
      thread_id: email.conversationId || '',
      subject: email.subject || '',
      body: bodyText,
      rawHtml: (email.body?.contentType === 'html') ? (email.body?.content || '') : '',
      received_date: email.receivedDateTime || new Date().toISOString(),
      forwarderEmail: email.from?.emailAddress?.address || '',
      forwarderName: email.from?.emailAddress?.name || '',
      hasAttachments: email.hasAttachments || attachmentHints.length > 0,
      attachmentHints: attachmentHints,
      source: 'outlook'
    }
  });
}

return results;
