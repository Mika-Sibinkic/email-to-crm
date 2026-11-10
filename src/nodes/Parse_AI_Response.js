// Parse AI Response v3.33 — stub-creation ANTI-DROP GUARD (stub-name regression fix, 2026-04-23)
//
// v3.33 CHANGES (minimal, one regression + stub field preservation):
//   OBSERVED FAILURE (2026-04-22 sanity batch exec 1448): "FW: example listing" body contains
//     "Mr. John Broker / Founder/Head of Sales / assistant@example-broker.com / Mobile: 555-010-0199"
//   v3.32 flow: Ollama returns 0 → stub creation → email local-part 'assistant' splits to single
//     token [assistant] → stub firstName/lastName empty → Validate Contact Type ghost-filter drops
//     the stub (if (!firstName && !lastName) return false). Baseline (pre-v3.32) extracted the contact.
//     Verified real regression 2026-04-23: 3 re-fires, 3/3 misses (execs 1487/1488/1490).
//   FIX: new helper deriveNameFromBodyNear(body, email, forwarderEmail) — when local-part doesn't
//     yield first+last, scan ±5 lines around the email for "Mr./Ms./Dr. First Last" or standalone
//     "First Last" on its own line. Also captures Mobile/Office phone and a short job-title line
//     between the name and the email. Excludes own staff, forwarder name, branding, and
//     common English/industry words to avoid reopening the ghost-contact leak v3.27 closed.
//   FIELD PROPAGATION: stub push now passes frag.mobile + frag.jobTitle through (v3.32 hardcoded
//     these to '' even though surrounding code set them). Fixes the case above to get 555-010-0199 captured.
//
// v3.32 SIGNATURE SCANNER PHONE REGEX EXTENDED
// Observed failures (Apr 20 2026):
//   Contact A         signature: "O 555-010-0101" / "C  555-010-0102"   (single-letter labels)
//   Contact B         signature: "O |  555.010.0103" / "M |  555.010.0104"  (letter + pipe)
//   Contact C         signature: "(c) 555.010.0105"                     (parenthesized letter)
// None matched the prior regex:
//   (?:T(?:el(?:ephone)?)?|P(?:h(?:one)?)?|Office(?:\s*Phone)?|Business|Direct\s+Line)\s*[:\s]?\s*(...)
// Changes:
//  1. Add standalone "O" (office) to phone regex — mirroring existing "P"/"T" standalone
//  2. Add standalone "C" (cell) to mobile regex — mirroring existing "M" standalone
//  3. Add parenthesized-letter prefixes (t)(p)(o) for phone, (m)(c) for mobile
//  4. Widen separator from [:\s]? to [:|\s]* to accept "|" (and zero-or-more)
//  5. Anchor label with \b word-boundary to avoid false positives on "Director"/"Top"/etc.
// Patched at 5 locations: primary signature scanner (before-email at line ~756 & ~792),
//   after-email scanner (~989 & ~1016), and TLD-less fallback scanner (~1181 & ~1188).
//
// Parse AI Response v3.30b — TLD-less email recovery with web verification
// v3.29 CHANGE LOG:
// - FIX 1: Emails without TLD (e.g., "jane.broker@examplegroup") are now resolved by
//   probing common TLDs (.com, .net, .org, .co, .ca, .io) and verifying each candidate by
//   fetching the homepage and checking if the company name from the email appears on the page.
//   The verified domain is used — no guesswork. Falls back to MX-first candidate if web
//   verification fails, and .com as last resort.
//   Observed failure: Jane Broker (The Example Group) → email="", zohoSkipped=true,
//   because jane.broker@examplegroup didn't match the TLD-requiring email regex.
//
// Parse AI Response v3.27 — name-aware pipe-split + phone dedup + ghost contact filter
// v3.27 CHANGE LOG:
// - FIX 1: Pipe-split title now detects when first part is the contact's name and skips it.
//   "Jane Broker | Director | Finance | Example Specialist Sectors" → title="Director", company="Example Specialist Sectors"
//   Observed failure: Jane Broker → jobTitle contained full name + title pipe string
// - FIX 2: Phone dedup — if phone and mobile are the same number, clear mobile.
//   Observed failure: Jane Broker → Phone and Mobile both 1-555-010-0106
// - FIX 3: Ghost contact filter — remove contacts with very short names and no email.
//   Observed failure: a broker email → "Wiz" and "Wry" extracted as ghost contacts
//
// Parse AI Response v3.26 — Name dedup, punctuation strip, title/company cleanup, OCR dedup
// v3.26 CHANGE LOG:
// - FIX 1: Full name-based dedup after merge — when multiple contacts share the same name,
//   keep the one with the best data (most fields, non-generic email, highest confidence).
//   Fixes triple-duplicate bug (#661).
// - FIX 2: Name punctuation stripping + "Last, First" detection — strip trailing commas/semicolons
//   from names, detect "Broker, J." pattern and swap to firstName="J." lastName="Broker".
// - FIX 3: Title/Company pipe-split — smart splitting of "Title | Company" in either field,
//   company===title dedup (derive from domain), company===person name cleanup.
// - FIX 4: Drop incomplete PDF OCR duplicates — OCR contacts with no lastName AND no email
//   are dropped when a better-sourced contact shares the same firstName.
// - Added 'fraud','abuse','spam','security' to GENERIC_PREFIXES set.
//
// Parse AI Response v3.23 — Recursive contact completion: stub creation from fragments
// v3.23: When all extraction paths produce 0 contacts but AI narrative or email body
// contains identifiable fragments (name, company, email, phone, URL), create stub contacts
// with needsWebResearch=true so the Web Research node can fill missing fields.
//
// Parse AI Response v3.21 — URL discovery for forwarded URL-only emails + AI narrative header fallback
// CHANGE LOG v3.21:
// - FIX 1: URL discovery activation for forwarded URL-only emails. When subject IS a URL
//   (after stripping Fwd:/Fw:/FW:/Re: prefixes) and AI returns 0 contacts, urlDiscoveryMode
//   now activates correctly. Also triggers when body is very short (<100 non-whitespace chars)
//   and allUrls has entries. Observed failure: example-broker.com/our-crew/ not researched.
// - FIX 2: AI narrative header fallback. When AI returns narrative text (aiParseError=true)
//   mentioning contacts by email, but those emails only appear on From:/To:/Cc: header lines
//   (so the scanner skips them), a fallback now extracts those contacts from the narrative.
//   Observed failure: a header-only contact (execution 577) dropped — email only on To: line.
//
// Parse AI Response v3.20 — fullBody TDZ fix + LLC title guard + sales suffix + standalone phone
// CHANGE LOG v3.20:
// - FIX 1: fullBody temporal dead zone — const fullBody was declared at line ~1345 but used
//   at line ~1280 (v3.17 firstName header fallback). Any contact with empty firstName caused
//   ReferenceError: Cannot access 'fullBody' before initialization → 0 contacts returned.
//   Observed failure: a contact with empty firstName → contactCount=0 (execution 458).
// - FIX 2: LLC/Inc/Corp guard on title regex — lines containing corporate suffixes (LLC, Inc,
//   Corp, LLP, Ltd) are company names, not job titles. "Example Principal Advisors, LLC" was
//   matching title regex due to "Principal" + "Advisors" keywords.
//   Observed failure: a contact → jobTitle="Example Principal Advisors, LLC" (execution 452).
// - FIX 3: Added "sales" to businessSuffixes for inferCompanyFromDomain. "acmeequipmentsales.com"
//   now splits to "Acme Equipment Sales" instead of "Acme Equipmentsales".
//   Observed failure: a contact → company="Acme Equipmentsales".
// - FIX 4: Standalone phone number detection — lines that are JUST a phone number (no label
//   prefix like "Phone:" or "Office:") now captured as phone. Common in compact signatures.
//   Observed failure: a bank contact → "555.010.0107" not captured (execution 460).
//
// CHANGE LOG v3.19:
// - FIX 1: Merge guard — when scanner's firstName+lastName matches the jobTitle (e.g., "Vice President"),
//   prefer AI's name instead. Scanner misidentified title as name for Jane O'Broker / Example Equipment.
//   Observed failure: Example Equipment → firstName=Vice, lastName=President (execution 449).
// - FIX 2: Smart quotes in name regex — Unicode apostrophes (\u2018, \u2019) now accepted.
//   "Jane O\u2019Broker" was not matching the name pattern. Observed failure: O'Broker not detected.
// - FIX 3: "Company:" label prefix detection in scanner. Lines starting with "Company:" now
//   captured as company name directly. Previously relied on keyword matching which missed
//   "EXAMPLE EQUIPMENT LEASING COMPANY" (no matching keywords like Bank/Capital/etc).
//   Observed failure: company=Exampleco (domain inferred) instead of EXAMPLE EQUIPMENT LEASING COMPANY.
// - FIX 4: "Direct Line" added to phone regex. "Direct Line: 555-010-0108" was not matched
//   by any regex — "Direct" alone maps to mobile, but "Direct Line" is an office phone.
//   Observed failure: 555-010-0108 only captured via AI, not scanner.
// - FIX 5: Company keyword list expanded — added Leasing, Company, Equipment, Properties,
//   Consulting, Development, Construction, Engineering, Technology, Systems.
//
// CHANGE LOG v3.18:
// - FIX 1: "Direct" label now maps to mobile field (was phone). Convention: office=phone,
//   direct/cell=mobile. "Direct" means the contact's personal direct dial.
//   Observed failure: a contact → only office phone captured, direct number missed.
// - FIX 2: Number-then-label phone patterns. Signatures like "555.010.0109 office" and
//   "555.010.0110 direct" now captured. Previously only "Office: 555.010.0109" format worked.
//   Observed failure: a contact → 0 phones extracted (labels after numbers).
// - FIX 3: From-header body scan fallback. When external email appears ONLY in a From: header
//   (not in signature), scanner now extracts name from header and scans the forwarded message
//   body for phone, company, address. Fixes emails where contact info is in email body below
//   headers, not in a traditional signature block.
//   Observed failure: a contact → scanner returned 0 fields (email in From: header skipped).
//
// CHANGE LOG v3.17:
// - FIX 1: isOwnCompanyPhone() now runs on ALL contact phone/mobile fields in the sanity check,
//   not just during signature scanning. Fixes a bug where AI extracted an internal staff phone
//   (555.010.0111) because it appeared in the forwarded email body.
//   Observed failure: Jane Broker → phone = an internal staff mobile (execution 431).
// - FIX 2: When AI returns empty firstName but has email, extract name from From/To/Cc
//   headers in the email body. Fixes a bug where AI returned lastName="Broker"
//   but missed firstName="Jane" (only appeared in "To: Jane Broker <JBroker@...>").
//   Observed failure: Jane Broker → firstName="" (execution 431).
//
// CHANGE LOG v3.16:
// - FIX 1: isPhoneNumber() vanity conversion now only applies when string starts with phone-like chars
//   (digits, parens, +). "Example Brokers" no longer falsely detected as phone number.
// - FIX 2: findDomainCorrelatedCompany allows trailing "." when preceded by Inc/Ltd/Corp/Co.
//   "Example Logic, Inc." no longer rejected by sentence guard.
// - FIX 3: Post-merge company guard + pipe-split re-applied after scanner-AI merge.
// - FIX 4: Phone/mobile vanity digit counting for validation (DEAL=3325 counts as 4 digits).
// - FIX 5: Bare vanity phone extraction in signature scanner.
//
// CHANGE LOG v3.15:
// - FIX: BLACKLIST + PHONE-IN-COMPANY GUARDS NOW APPLIED TO AI OUTPUT
//   v3.14 only applied these guards during signature scanning. The AI-extracted
//   company field bypassed them entirely because companyInSource() returned true
//   (the tagline IS in the email, inside the forwarder's signature). Now these guards run
//   in both the normalization phase (before pipe-split) AND the validation phase.
//   Observed failures: case A → company = own-company tagline, case B → company = phone number.
//
// CHANGE LOG v3.15:
// - FIX 1: AI-EXTRACTED COMPANY GUARD — isPhoneNumber() and isOwnBranding()
//   now run on AI-extracted company values BEFORE title-pipe split, not just signature scan.
//   Fixes case B (company = phone) and case A (company = own-company tagline).
// - FIX 2: DOMAIN CORRELATION SPACE-INSENSITIVE — findDomainCorrelatedCompany now
//   matches after removing spaces, so "Example Logic" matches domain root "examplelogic".
//
// CHANGE LOG v3.14:
// - FIX 1: OWN-COMPANY TAGLINE BLACKLIST — the firm's signature tagline was passing the
//   company keyword regex because it contains company keywords.
//   Added blacklist of known own-company taglines/branding strings.
// - FIX 2: PHONE-IN-COMPANY GUARD — Company field sometimes receives phone numbers
//   (e.g., "(555) 010-DEAL" as company). Reject company values that are primarily digits/phone chars.
// - FIX 3: TITLE-PIPE SPLIT — When jobTitle contains "|", the second part is often the company
//   (e.g., "Senior Sales Director | Example Brokers"). Split and extract company from pipe.
// - FIX 4: INTERNATIONAL PHONE VALIDATION — phoneInSource was failing on international numbers
//   like "+90 555 010 0 112". Now handles intl prefix and varied spacing.
// - FIX 5: COUNTRY FIELD — Scanner now extracts country when present (e.g., "TURKEY" after city/state).
//   State vs Country disambiguation for non-US values.
// - FIX 6: DOMAIN-INFERRED COMPANY SPACING — "Acmeprivatewealth" from domain inference
//   now gets camelCase splitting: "Acme Private Wealth".
//
// CHANGE LOG v3.13:
// - CRITICAL: Changed $input.first() → $input.all() loop.
//   When Ollama processes multiple extraction requests (one per email),
//   each AI response is now parsed independently.
// - prevData now uses index-correlated $('Email Parser').all()[_idx]
//   instead of .first(), so each AI response references the correct email.
// - Early returns (skip, AI failure) changed to allResults.push + continue.
//
// CHANGE LOG v3.12:
// - v3.12: Added pipe-separated navigation link guard for company extraction.
//   Lines like "VIDEOS  |  CREDIT APPLICATION  |" contain "Credit" (a company
//   keyword) but are signature navigation bars, not company names. Any line with
//   2+ pipe characters is now skipped. Applied in both before-email and after-email scans.
//
// CHANGE LOG v3.11:
// - v3.11: SIX FIXES addressing all known scanner bugs (Feb 25):
//
//   FIX 1: NAME EXTRACTION — single-word email addresses like "jane@exampleco.com"
//     Previously inferNameFromEmail returned {firstInitial:"a", lastHint:"nthony"} which
//     never matched "Jane Broker". Now returns fullLocalAsFirst:"jane" which matches
//     any candidate whose first name equals the full email local part. Fixes the
//     "Example Co" → firstName bug (was grabbing company name as person name).
//
//   FIX 2: FALLBACK NAME PRIORITY — Always overwrite fallback with farthest-from-email match.
//     In signatures, the person's name is at the TOP (farthest from email), company is closer.
//     Previously only stored the FIRST fallback (closest = often company name).
//     Now keeps overwriting so the topmost name candidate wins.
//
//   FIX 3: AFTER-EMAIL SCAN BOUNDARY — Stop scanning when hitting another person's email.
//     Scanner was crossing from the contact's signature into the forwarder's own-company
//     signature (15 lines after the email), picking up the forwarder's city/state/zip as the contact's city.
//     Now stops the after-email scan when encountering any email address other than the
//     current contact's email (signals a different person's signature block).
//
//   FIX 4: COMPANY NAME — Reject lines containing @ or starting with URL patterns.
//     "JBROKER@EXAMPLE.BANK | EXAMPLELENDING.COM" was grabbed as company because it
//     contains "BANK". Now skips any line with @ or http/www prefix for company extraction.
//
//   FIX 5: PHONE REGEX — Accept bare "P" prefix for phone numbers.
//     "P 555-010-0113" is a common signature format. The regex previously required "Ph" or
//     "Phone" minimum. Now matches "P" followed by separator + digits.
//
//   FIX 6: NAME-COMPANY COLLISION — Don't accept a name candidate that matches the already-
//     extracted company name. Prevents lines like "Atlantic Holdings" from being stored as
//     both company AND fallback person name.
//
// CHANGE LOG v3.10:
//   FIX 1: REMOVED isOwnAddress() GUARD ENTIRELY.
//   FIX 2: EXPANDED OWN_PHONES BLACKLIST with all team members.
//
// CHANGE LOG v3.9:
//   FIX C: OWN-SIGNATURE CONTAMINATION GUARD
//   FIX D: TITLE CASE NORMALIZATION
//   FIX E: AI COMMENTARY GUARD
// - v3.8: FIX PERSONAL-ONLY-CONTACTS REGRESSION — hasOnlyPersonalContacts → needsWebResearch = true
// - v3.7: FIX PRIVATE BANK BUG via EMAIL-HINT-GUIDED NAME EXTRACTION
// - v3.6: ALWAYS-ON SIGNATURE SCANNER replaces fallback-only approach
// - v3.5: (Superseded) Fallback signature extraction
// - v3.4: Comprehensive source-text validation
// - v3.3: Fixed website enrichment order, phone label stripping, jobTitle/type echo detection
// - Updated prevData node reference to current Email Parser1

// ═══ v3.13: MULTI-ITEM WRAPPER — Process each AI response independently ═══
const allItems = $input.all();
const allResults = [];
// Pre-fetch Email Parser items for index-based correlation
let emailParserItems = [];
try { emailParserItems = $('Email Parser').all(); } catch(e) {
  try { emailParserItems = $('Email Parser').all(); } catch(e2) {}
}

for (let _idx = 0; _idx < allItems.length; _idx++) {
const _item = allItems[_idx];

// ═══ SKIP_CHECK — Pass through skip signal ═══
if (_item.json.skip) {
  allResults.push({ json: _item.json });
  continue;
}

// ═══ OLLAMA_FAILURE_GUARD — Handle AI timeout/crash/garbage ═══
const rawInput = _item.json;

// Safe reference to Email Parser — use index-correlated item for multi-email support
// v3.13: emailParserItems[_idx] gives us the Email Parser output that corresponds
// to THIS particular AI response (same position in the pipeline).
let prevData = {};
try {
  prevData = (emailParserItems[_idx] || emailParserItems[0] || {}).json || {};
} catch (e) {
  prevData = {};
}

// If Ollama returned an error (continueOnFail caught it), don't crash
if (rawInput.error || rawInput.statusCode >= 400 || (!rawInput.response && !rawInput.message)) {
  allResults.push({ json: {
    contacts: [],
    aiRawResponse: 'AI_FAILURE: ' + (rawInput.error || rawInput.statusMessage || 'No response from AI'),
    needsWebResearch: true,
    hasPdfAttachment: (prevData.attachmentHints || []).includes('PDF'),
    hasImageAttachment: (prevData.attachmentHints || []).includes('IMAGE'),
    extractionStrategy: prevData.extractionStrategy || 'BODY_ONLY',
    originalSubject: prevData.originalSubject || '',
    fullBody: prevData.fullBody || '',
    forwarderInstruction: prevData.forwarderInstruction || '',
    suggestedType: prevData.suggestedType || '',
    email_id: prevData.email_id || '',
    forwarderEmail: prevData.forwarderEmail || '',
    primaryUrl: prevData.primaryUrl || '',
    allUrls: prevData.allUrls || [],
    hasAttachments: prevData.hasAttachments || false,
    attachmentHints: prevData.attachmentHints || []
  }});
  continue;  // v3.13: continue to next item instead of returning
}

// ═══════════════════════════════════════════════════════════════
// v3.6: DETERMINISTIC SIGNATURE SCANNER
// Runs on EVERY email. Extracts contacts from signature blocks
// using regex — fast, reliable, no AI hallucination possible.
// ═══════════════════════════════════════════════════════════════

// v3.9: TITLE CASE NORMALIZATION
// "JANE BROKER" → "Jane Broker", "PRIVATE BANK" → "Private Bank"
// Only converts when the ENTIRE string is uppercase (won't touch "McDonald" or "De La Cruz")
function toTitleCase(str) {
  if (!str || str.length < 2) return str;
  // Check if ALL alphabetic chars are uppercase
  const alphaChars = str.replace(/[^a-zA-Z]/g, '');
  if (alphaChars.length < 2 || alphaChars !== alphaChars.toUpperCase()) return str;
  // Convert: "JANE BROKER" → "Jane Broker"
  return str.toLowerCase().replace(/(?:^|\s|[-'])\w/g, c => c.toUpperCase());
}

// ═══════════════════════════════════════════════════════════════
// v3.9 + v3.10: OWN-COMPANY PHONE NUMBER BLACKLIST
// ═══════════════════════════════════════════════════════════════
// Populate with the firm's own phone numbers (last 10 digits) so they are never captured as contact phones.
const OWN_PHONES = new Set([
  // Office lines
  '5550100101',   // Main office
  '5550100102',   // Office line 2
  '5550100103',   // Office line 3
  '5550100104',   // Alt office (add others as discovered)
  // Personal mobiles
  '5550100105',   // Staff mobile 1
  '5550100106',   // Staff mobile 2
  '5550100107',   // Staff mobile 3
  '5550100108',   // Staff mobile 4
  // Fax
  '5550100109',   // Shared fax line (all team members)
  // Toll-free (add as discovered)
  '5550100110',
]);

function isOwnCompanyPhone(phoneStr) {
  if (!phoneStr) return false;
  const digits = phoneStr.replace(/\D/g, '');
  // Check last 10 digits (strip country code)
  const last10 = digits.length > 10 ? digits.slice(-10) : digits;
  return OWN_PHONES.has(last10);
}

// v3.33 ANTI-DROP GUARD — when email local-part yields no derivable name, scan body lines
// near the email for a "Mr./Ms./Dr. First Last" or standalone "First Last" pattern. Fixes
// unmatched-local-part class: body has 'Mr. John Broker / Founder... / assistant@example-broker.com'
// but local-part 'assistant' splits to single token, prior v3.32 stub had empty name and was
// dropped by Validate Contact Type's ghost filter.
// Populate with the firm's own staff so their signatures are never extracted as contacts.
const ANTI_DROP_FIRST_STOP = new Set(['alex','pat','taylor','morgan','casey','robin','lee']);
const ANTI_DROP_LAST_STOP = new Set(['example','sample','placeholder','demo','specimen','template']);
const ANTI_DROP_WORD_STOP = new Set(['the','that','this','with','from','into','about','which','their','there','other','some','these','those','will','been','have','each','make','like','just','over','such','also','back','than','them','then','only','come','made','find','here','know','take','want','does','when','what','your','more','many','very','most','much','after','first','last','before','being','under','could','would','should','because','between','through','during','without','contact','contacts','person','name','found','identified','following','information','field','fields','email','phone','company','title','address','joining','dealer','broker','lending','sincerely','regards','thanks','best','price','drop','motivated','seller','global','mobile','office','direct','cell','founder','head','sales','ceo','president','vice','managing','principal','partner','director','manager']);
function deriveNameFromBodyNear(body, email, forwarderEmail) {
  if (!body || !email) return { firstName: '', lastName: '', phone: '', mobile: '', jobTitle: '' };
  const emailLc = email.toLowerCase();
  const lines = body.split(/\r?\n/);
  const forwarderLocal = ((forwarderEmail || '').split('@')[0] || '').toLowerCase();
  const phoneRe = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(emailLc)) continue;
    const scanStart = Math.max(0, i - 5);
    const scanEnd = Math.min(lines.length, i + 4);
    let firstName = '', lastName = '', jobTitle = '';
    let phone = '', mobile = '';
    for (let j = scanStart; j < scanEnd; j++) {
      if (j === i) continue;
      const raw = lines[j].trim();
      if (!raw || raw.length > 120) continue;

      // NAME: title-prefixed OR bare "First Last" on its own line
      if (!firstName) {
        const m = raw.match(/^(?:Mr\.?|Ms\.?|Mrs\.?|Miss|Dr\.?|Prof\.?)?\s*([A-Z][a-zA-Z'’\-]+)\s+([A-Z][a-zA-Z'’\-]+)(?:\s+([A-Z][a-zA-Z'’\-]+))?\s*$/);
        if (m) {
          const f = m[1], l = (m[3] ? m[3] : m[2]);
          const fLc = f.toLowerCase(), lLc = l.toLowerCase();
          const nameOk = !ANTI_DROP_WORD_STOP.has(fLc) && !ANTI_DROP_WORD_STOP.has(lLc)
            && !(ANTI_DROP_FIRST_STOP.has(fLc) && ANTI_DROP_LAST_STOP.has(lLc))
            && fLc !== forwarderLocal && lLc !== forwarderLocal
            && !isOwnBranding(f + ' ' + l);
          if (nameOk) { firstName = f; lastName = l; }
        }
      }
      // PHONE / MOBILE: labelled lines near the email
      const phoneMatch = raw.match(phoneRe);
      if (phoneMatch && !isOwnCompanyPhone(phoneMatch[0])) {
        const labeled = raw.toLowerCase();
        if (/mobile|cell|^m\b|^c\b|\(m\)|\(c\)/.test(labeled) && !mobile) {
          mobile = phoneMatch[0].trim();
        } else if (/office|direct|phone|^o\b|^p\b|\(o\)|\(p\)|\(t\)/.test(labeled) && !phone) {
          phone = phoneMatch[0].trim();
        } else if (!phone && !mobile) {
          // unlabeled phone near the email → fill phone slot
          phone = phoneMatch[0].trim();
        }
      }
      // JOB TITLE: a short line that's not a name, not a phone, not a URL — between name line and email line
      if (!jobTitle && firstName && j > scanStart) {
        if (!/\d/.test(raw) && !raw.includes('@') && raw.length <= 60 && /^[A-Z]/.test(raw)
            && !raw.match(/^(?:Mr\.?|Ms\.?|Mrs\.?|Miss|Dr\.?|Prof\.?)?\s*[A-Z][a-zA-Z'’\-]+\s+[A-Z][a-zA-Z'’\-]+\s*$/)) {
          jobTitle = raw;
        }
      }
    }
    if (firstName && lastName) {
      return { firstName, lastName, phone, mobile, jobTitle };
    }
  }
  return { firstName: '', lastName: '', phone: '', mobile: '', jobTitle: '' };
}

// ═══ v3.14: OWN-COMPANY TAGLINE/BRANDING BLACKLIST ═══
// These strings appear in staff signatures and should NEVER be extracted as company names.
const OWN_COMPANY_BLACKLIST = new Set([
  'your company tagline here',
  'your company',
  'yourcompany',
  'click here to send us files securely',
]);

function isOwnBranding(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  if (OWN_COMPANY_BLACKLIST.has(lower)) return true;
  // Also catch partial matches
  if (lower.includes('your company tagline here')) return true;
  if (lower.includes('your company')) return true;
  return false;
}

// v3.16: Detect if a string is primarily a phone number (not a company)
// v3.16 FIX: Only applies vanity conversion when the string starts with phone-like
// characters (digits, parens, +). Pure text like "Example Brokers" is NOT vanity-converted
// because that would falsely turn all letters into digits (ratio 85% → false positive).
function isPhoneNumber(str) {
  if (!str) return false;
  const trimmed = str.trim();
  // Direct phone pattern check (no vanity needed)
  if (/^\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/.test(trimmed)) return true;
  if (/^\+?\d[\d\s.\-()]{6,}$/.test(trimmed)) return true;
  // Raw digit ratio check (without vanity conversion)
  const rawDigits = str.replace(/\D/g, '');
  if (rawDigits.length >= 7 && rawDigits.length / str.length > 0.4) return true;
  // Vanity conversion ONLY if string starts with a phone-like prefix
  // e.g., "(555) 010-DEAL" or "1-555-GET-DEAL" — NOT "Example Brokers"
  if (/^[\d(+]/.test(trimmed)) {
    const vanityMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
    const vanityConverted = str.replace(/[A-Za-z]/g, ch => vanityMap[ch.toUpperCase()] || ch);
    const digits = vanityConverted.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length / str.length > 0.4) return true;
  }
  return false;
}

// ═══ v3.29: ASYNC TLD RESOLVER — web-verified domain resolution ═══
// When an email has no TLD (e.g., "jane.broker@examplegroup"), probe common TLDs
// and verify by fetching the homepage + checking if the company name appears.
async function resolveTldLessEmail(tldLessEmail, companyHint) {
  const https = require('https');
  const dns = require('dns').promises;
  const [localPart, domain] = tldLessEmail.split('@');
  if (!domain || domain.length < 3) return null;

  const CANDIDATE_TLDS = ['com', 'net', 'org', 'co', 'ca', 'io'];
  const companyLower = (companyHint || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const companyWords = companyLower.split(/\s+/).filter(w => w.length >= 3);

  // Phase 1: DNS MX check — which TLDs can actually receive mail?
  const mxCandidates = [];
  await Promise.all(CANDIDATE_TLDS.map(async (tld) => {
    try {
      const mx = await dns.resolveMx(domain + '.' + tld);
      if (mx && mx.length > 0) {
        mxCandidates.push({ tld, mx: mx[0].exchange, priority: mx[0].priority });
      }
    } catch (e) { /* no MX = skip */ }
  }));

  if (mxCandidates.length === 0) return localPart + '@' + domain + '.com'; // absolute fallback
  if (mxCandidates.length === 1) return localPart + '@' + domain + '.' + mxCandidates[0].tld;

  // Phase 2: Multiple MX candidates — verify by homepage content + company name match
  function fetchPage(url, timeout) {
    return new Promise((resolve) => {
      const req = https.get(url, { timeout, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        // Follow one redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redir = res.headers.location.startsWith('http') ? res.headers.location : url.split('/').slice(0,3).join('/') + res.headers.location;
          return fetchPage(redir, timeout).then(resolve);
        }
        let data = '';
        res.on('data', chunk => { data += chunk; if (data.length > 50000) res.destroy(); });
        res.on('end', () => resolve(data));
        res.on('error', () => resolve(''));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
  }

  let bestTld = null;
  let bestScore = -1;

  for (const candidate of mxCandidates) {
    try {
      const fullDomain = domain + '.' + candidate.tld;
      const html = await fetchPage('https://' + fullDomain, 4000);
      if (!html || html.length < 200) continue; // parked/empty page

      const textContent = html.replace(/<[^>]*>/g, ' ').toLowerCase();
      let score = 0;

      // Score by content size (real sites > parked pages)
      if (html.length > 10000) score += 2;
      if (html.length > 50000) score += 1;

      // Score by company name match
      if (companyWords.length > 0) {
        const matchedWords = companyWords.filter(w => textContent.includes(w));
        score += matchedWords.length * 3; // Strong signal
      }

      // Score by domain appearing in page content (self-references)
      if (textContent.includes(fullDomain)) score += 1;

      if (score > bestScore) {
        bestScore = score;
        bestTld = candidate.tld;
      }
    } catch (e) { /* fetch failed — skip */ }
  }

  // Use web-verified TLD if found, otherwise fall back to lowest-priority MX
  if (bestTld) return localPart + '@' + domain + '.' + bestTld;
  mxCandidates.sort((a, b) => a.priority - b.priority);
  return localPart + '@' + domain + '.' + mxCandidates[0].tld;
}

function scanSignatures(body, excludeForwarder) {
  if (!body || body.length < 50) return [];

  const PERSONAL_DOMAINS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
    'aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com','mail.com',
    'zoho.com','yandex.com','gmx.com','comcast.net','att.net','verizon.net']);

  // Find all unique email addresses in the body
  const emailRegex = /[\w.+-]+@[\w.-]+\.\w{2,}/g;
  const allEmails = [...new Set((body.match(emailRegex) || []).map(e => e.toLowerCase()))];

  // v3.29: Capture TLD-less emails for later async verification
  // These appear when Outlook truncates the display or domain has no public TLD
  const tldLessRegex = /[\w.+-]+@[a-zA-Z][\w-]{2,}(?=[\s,;>)\]"']|$)/g;
  const tldLessCandidates = (body.match(tldLessRegex) || [])
    .map(e => e.toLowerCase())
    .filter(e => !allEmails.some(full => full.startsWith(e))); // Not already captured with TLD
  // Store for async resolution later — don't guess TLD here
  const _pendingTldLess = [];
  for (const candidate of tldLessCandidates) {
    const domain = candidate.split('@')[1];
    if (domain && domain.length >= 3 && !allEmails.some(e => e.split('@')[1]?.startsWith(domain))) {
      _pendingTldLess.push(candidate);
    }
  }

  // Filter to external, non-personal, non-forwarder emails
  const GENERIC_PREFIXES = new Set(['info','sales','support','admin','contact',
    'help','billing','noreply','no-reply','mailer-daemon','postmaster',
    'webmaster','newsletter','marketing','service','enquiries','enquiry',
    'fraud','abuse','spam','security']);

  const externalEmails = allEmails.filter(e => {
    const domain = e.split('@')[1] || '';
    const localPart = e.split('@')[0] || '';
    return !e.endsWith('@yourcompany.com') &&
           !e.endsWith('@example-consultancy.com') &&
           e !== (excludeForwarder || '').toLowerCase() &&
           !PERSONAL_DOMAINS.has(domain) &&
           !GENERIC_PREFIXES.has(localPart.toLowerCase());
  });

  // ═══════════════════════════════════════════════════════════════
  // v3.7 + v3.11: Infer name hints from the email local part
  // "jane.a.broker" → { firstHint: "jane", lastHint: "broker" }
  // "jbroker" → { firstInitial: "j", lastHint: "broker" }
  // v3.11: "jane" → { firstInitial: "j", lastHint: "ane", fullLocalAsFirst: "jane" }
  //   fullLocalAsFirst allows matching when the entire local part IS a first name
  // ═══════════════════════════════════════════════════════════════
  function inferNameFromEmail(email) {
    const local = email.split('@')[0].toLowerCase().replace(/^\d+/, '').replace(/\d+$/, '');
    const parts = local.split(/[._-]/);

    if (parts.length >= 3) {
      // first.middle.last or first.m.last — take first and last significant parts
      const sig = parts.filter(p => p.length > 1);
      if (sig.length >= 2) return { firstHint: sig[0], lastHint: sig[sig.length - 1] };
    }
    if (parts.length === 2) {
      if (parts[0].length > 1 && parts[1].length > 1) return { firstHint: parts[0], lastHint: parts[1] };
      if (parts[0].length === 1) return { firstInitial: parts[0], lastHint: parts[1] };
      if (parts[1].length === 1) return { firstHint: parts[0], lastInitial: parts[1] };
    }
    if (parts.length === 1 && local.length > 3) {
      // v3.11 FIX 1: Single word like "jane" or "jbroker"
      // Could be: (a) full first name "jane@exampleco.com"
      //           (b) first initial + last "jbroker@somecompany.com"
      // Return BOTH interpretations so nameMatchesHints can try each
      return {
        firstInitial: local[0],
        lastHint: local.substring(1),
        fullLocalAsFirst: local  // v3.11: try entire local as first name
      };
    }
    return null;
  }

  // v3.7 + v3.11: Check if a candidate name matches email-derived hints
  function nameMatchesHints(first, last, nick, hints) {
    if (!hints) return false;
    const fL = first.toLowerCase(), lL = last.toLowerCase(), nL = (nick || '').toLowerCase();

    // Match 1: Full first + last (e.g., "jane.broker@...")
    if (hints.firstHint && hints.lastHint) {
      const firstOk = (fL === hints.firstHint || nL === hints.firstHint);
      const lastOk = (lL === hints.lastHint);
      if (firstOk && lastOk) return true;
    }

    // Match 2: First initial + last (e.g., "jbroker@..." → J. Broker)
    if (hints.firstInitial && hints.lastHint) {
      if ((fL[0] === hints.firstInitial || (nL && nL[0] === hints.firstInitial)) && lL === hints.lastHint)
        return true;
    }

    // Match 3: First + last initial (e.g., "jane.b@...")
    if (hints.firstHint && hints.lastInitial) {
      if (fL === hints.firstHint && lL[0] === hints.lastInitial)
        return true;
    }

    // v3.11 FIX 1: Full local part IS the first name (e.g., "jane@exampleco.com")
    // Accept any candidate whose first name matches the entire email local part
    if (hints.fullLocalAsFirst) {
      if (fL === hints.fullLocalAsFirst || nL === hints.fullLocalAsFirst)
        return true;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // v3.12: DOMAIN-BASED COMPANY INFERENCE
  // The email domain is the single most reliable signal for company identity.
  // "jbroker@example.bank" → "Example Bank"
  // "jane@exampleco.com" → tries to find "Example Co" in nearby lines
  //
  // THREE-LAYER STRATEGY:
  //   Layer 1 — Domain correlation: scan lines for text matching the domain root
  //             "Example Bank" line + domain "example" = match
  //   Layer 2 — Keyword scanning: existing regex approach (Bank, Capital, etc.)
  //   Layer 3 — Domain inference: synthesize name from domain + TLD
  //             example + .bank = "Example Bank"
  // ═══════════════════════════════════════════════════════════════
  const MEANINGFUL_TLDS = {
    'bank': 'Bank', 'insurance': 'Insurance', 'financial': 'Financial',
    'capital': 'Capital', 'fund': 'Fund', 'investments': 'Investments',
    'law': 'Law', 'legal': 'Legal', 'consulting': 'Consulting',
    'realty': 'Realty', 'mortgage': 'Mortgage', 'credit': 'Credit',
    'trust': 'Trust', 'holdings': 'Holdings', 'energy': 'Energy',
    'health': 'Health', 'tech': 'Tech', 'systems': 'Systems',
    'group': 'Group', 'partners': 'Partners', 'ventures': 'Ventures'
  };

  function extractDomainRoot(email) {
    const domain = (email.split('@')[1] || '').toLowerCase();
    const parts = domain.split('.');
    if (parts.length < 2) return null;
    const tld = parts[parts.length - 1];
    // For two-part domains like "example.bank", root is parts[0]
    // For three-part like "mail.example.com", root is parts[parts.length - 2]
    const rootPart = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
    return { root: rootPart, tld, fullDomain: domain };
  }

  // Layer 1: Find a line in the signature that correlates with the email domain
  function findDomainCorrelatedCompany(lines, domainRoot) {
    if (!domainRoot || domainRoot.length < 3) return '';
    const rootLower = domainRoot.toLowerCase();
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
      const line = lines[i];
      if (/^(from|to|cc|date|subject|sent|-----)/i.test(line)) break;
      if (/confidential|privilege|disclaimer/i.test(line)) continue;
      if (line.length > 80 || line.length < 2) continue;
      // Skip email/URL lines
      if (/@/.test(line) || /^https?:\/\//i.test(line) || /^www\./i.test(line)) continue;
      // Skip phone lines
      if (/^(?:T(?:el)?|P(?:h(?:one)?)?|Office|Direct|Mobile|Cell|Fax|M\s)\s*[:\s]?\s*[\d(+]/i.test(line)) continue;
      // Check if this line contains the domain root word
      // e.g., line="Example Bank" contains "example"
      // v3.15: Space-insensitive match — "Example Logic" matches "examplelogic"
      const lineNoSpaces = line.toLowerCase().replace(/\s+/g, '');
      if (line.toLowerCase().includes(rootLower) || lineNoSpaces.includes(rootLower)) {
        // Extra check: the line should look like a company name, not a sentence
        // v3.16 FIX: Allow trailing "." when preceded by common abbreviations (Inc., Ltd., Corp., Co., etc.)
        const trimmedLine = line.trim();
        const endsWithSentencePunct = /[.!?]$/.test(trimmedLine) && !/(?:Inc|Ltd|Corp|Co|Jr|Sr|Esq|Dr|Mr|Mrs|Ms|LLC|LLP|P\.?C|L\.?C)\.\s*$/i.test(trimmedLine);
        if (!endsWithSentencePunct && !/^(good|hi |hello|please|thank|best|regard|we |the |a )/i.test(line)) {
          // If line has pipes, extract just the segment containing the domain root
          if (line.includes('|')) {
            const segments = line.split('|').map(s => s.trim()).filter(s => s.length > 0);
            // v3.16: Space-insensitive segment matching — "Example Brokers" matches "examplebrokers"
            const match = segments.find(s => {
              const sLower = s.toLowerCase();
              const sNoSpaces = sLower.replace(/\s+/g, '');
              return sLower.includes(rootLower) || sNoSpaces.includes(rootLower);
            });
            if (match && match.length < 50) return match;
          }
          return line;
        }
      }
    }
    return '';
  }

  // Layer 3: Synthesize company name from domain when no line match is found
  function inferCompanyFromDomain(email) {
    const info = extractDomainRoot(email);
    if (!info) return '';
    const { root, tld } = info;
    if (root.length < 3) return '';
    // v3.18: Iterative word splitting — "acmeprivatewealth" → "Acme Private Wealth"
    // Scans for known business suffixes and splits at each boundary, handling multiple words
    let name = root;
    // v3.20: Added 'sales' — "acmeequipmentsales" → "Acme Equipment Sales"
    const businessSuffixes = ['private', 'wealth', 'capital', 'financial', 'group', 'partners', 'advisors', 'advisory', 'management', 'holdings', 'investments', 'consulting', 'services', 'solutions', 'global', 'international', 'national', 'insurance', 'realty', 'mortgage', 'lending', 'credit', 'trust', 'fund', 'asset', 'bank', 'logic', 'sales', 'properties', 'development', 'construction', 'engineering', 'technology', 'systems', 'industries', 'equipment', 'leasing', 'enterprises', 'resources', 'associates', 'company', 'design', 'logistics', 'transport', 'trading', 'supply', 'energy', 'media', 'broker', 'air'];
    // Split iteratively: find leftmost suffix, split, repeat on remaining parts
    function splitOnSuffixes(str) {
      const lower = str.toLowerCase();
      let bestIdx = -1, bestSuffix = '';
      for (const suffix of businessSuffixes) {
        const idx = lower.indexOf(suffix);
        if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx;
          bestSuffix = suffix;
        }
      }
      if (bestIdx > 0) {
        const before = str.substring(0, bestIdx);
        const matched = str.substring(bestIdx, bestIdx + bestSuffix.length);
        const remainder = str.substring(bestIdx + bestSuffix.length);
        const parts = [before.charAt(0).toUpperCase() + before.slice(1),
                       matched.charAt(0).toUpperCase() + matched.slice(1)];
        if (remainder.length > 0) {
          const remainderParts = splitOnSuffixes(remainder);
          if (remainderParts) {
            parts.push(...remainderParts.split(' '));
          } else {
            // Check if remainder itself is a known suffix (starts at idx 0)
            const remLower = remainder.toLowerCase();
            const isFullSuffix = businessSuffixes.some(s => remLower === s);
            if (isFullSuffix) {
              parts.push(remainder.charAt(0).toUpperCase() + remainder.slice(1));
            } else {
              parts[parts.length - 1] += remainder;
            }
          }
        }
        return parts.join(' ');
      }
      return null;
    }
    const split = splitOnSuffixes(name);
    if (split) {
      name = split;
    }
    if (!name.includes(' ')) {
      name = name.charAt(0).toUpperCase() + name.slice(1);
    }
    // Append meaningful TLD if applicable
    const tldWord = MEANINGFUL_TLDS[tld];
    if (tldWord) return name + ' ' + tldWord;
    // For generic TLDs (.com, .net, .org), return just the name
    return name;
  }

  const results = [];
  const bodyLower = body.toLowerCase();

  for (const extEmail of externalEmails) {
    // Find ALL positions of this email in the body
    const positions = [];
    let searchFrom = 0;
    while (true) {
      const idx = bodyLower.indexOf(extEmail, searchFrom);
      if (idx === -1) break;
      positions.push(idx);
      searchFrom = idx + extEmail.length;
    }

    let bestContact = null;
    let bestScore = 0;

    for (const emailIdx of positions) {
      // Skip if this occurrence is on a header line (From:, To:, Cc:, Sent:)
      const lineStart = body.lastIndexOf('\n', emailIdx) + 1;
      const linePrefix = body.substring(lineStart, emailIdx).trim().toLowerCase();
      // "email:" prefix is a signature line, NOT a header — don't skip it
      if (/^(from|to|cc|bcc|sent|date|subject)\s*:/i.test(linePrefix)) {
        continue;
      }

      const beforeEmail = body.substring(Math.max(0, emailIdx - 1000), emailIdx);
      const afterEmail = body.substring(emailIdx, Math.min(body.length, emailIdx + 500));
      const lines = beforeEmail.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      let firstName = '', lastName = '', nickname = '';
      let fallbackFirst = '', fallbackLast = '', fallbackNick = '';
      let jobTitle = '', companyName = '';
      let phone = '', mobile = '', city = '', state = '', country = '';
      const nameHints = inferNameFromEmail(extEmail);

      // v3.7: Extract name from email headers as a reliable backup
      let headerFirst = '', headerLast = '';
      const escapedEmail = extEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const headerPattern = new RegExp('From:\\s*"?([^"<]+)"?\\s*<' + escapedEmail + '>', 'i');
      const headerNameMatch = body.match(headerPattern);
      if (headerNameMatch) {
        let rawName = headerNameMatch[1].trim().replace(/^["']|["']$/g, '');
        const hParts = rawName.split(/\s+/);
        if (hParts.length >= 2) {
          if (hParts[0].endsWith(',')) {
            headerLast = hParts[0].replace(',', '');
            headerFirst = hParts[1];
          } else {
            headerFirst = hParts[0];
            headerLast = hParts[hParts.length - 1];
          }
        }
      }

      // Search backwards through lines for signature fields
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
        const line = lines[i];

        // Stop if we hit email headers (we've gone past the signature)
        if (/^(From:|To:|Cc:|Date:|Subject:|Sent:|-----)/i.test(line)) break;
        if (/confidential|privilege|disclaimer|intended only/i.test(line)) continue;
        if (line.length > 200) continue; // Skip long paragraphs

        // v3.11 FIX 5: Phone — added "P" as standalone prefix
        // Handles: "P 555-010-0113", "Ph: 555-1234", "Phone: 555-1234",
        //          "Tel: 555-1234", "Office: 555-1234", "Direct: 555-1234"
        // v3.16: Also handles bare vanity numbers like "(555) 010-DEAL" or "(555) 011-DEAL"
        // v3.7: Exclude "Cell Phone" lines (handled by mobile regex below)
        // v3.9: Skip own-company phone numbers
        if (!phone && !/\bCell\b/i.test(line)) {
          // v3.18: Removed "Direct" — now maps to mobile by convention (office=phone, direct=mobile)
          // v3.19 FIX 4: Added "Direct Line" — this is an office direct line, not mobile
          const phoneMatch = line.match(/(?:\b(?:T(?:el(?:ephone)?)?|P(?:h(?:one)?)?|O(?:ffice(?:\s*Phone)?)?|Business|Direct\s+Line)\b|\((?:[tpo])\))\s*[:|\s]*([\d(+][\d\s.()\-]{6,}\d)/i);
          if (phoneMatch) {
            const candidate = phoneMatch[1].replace(/\s*[\(]?(?:ext|x|extension)\.?\s*\d+\)?\s*$/i, '').trim();
            if (!isOwnCompanyPhone(candidate)) {
              phone = candidate;
            }
          }
          // v3.16: Bare vanity phone — "(555) 010-DEAL" or "1-555-GET-DEAL"
          // Line starts with phone-like chars and contains a mix of digits and uppercase letters
          if (!phone) {
            const vanityMatch = line.match(/^(\(?\d{3}\)?[\s.\-]?\d{2,3}[\s.\-]?[A-Z]{2,}(?:\s*[-]\s*\([^)]+\))?)/i);
            if (vanityMatch) {
              // Convert vanity to digits and validate
              const raw = vanityMatch[1].replace(/\s*[-]\s*\([^)]+\)\s*$/, '').trim();
              const vMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
              const normalized = raw.replace(/[A-Za-z]/g, ch => vMap[ch.toUpperCase()] || ch);
              const digits = normalized.replace(/\D/g, '');
              if (digits.length >= 7 && !isOwnCompanyPhone(normalized)) {
                phone = normalized;
              }
            }
          }
          // v3.18: Number-then-label pattern — "555.010.0109 office"
          if (!phone) {
            const phoneSuffix = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:office|business|main|work)\b/i);
            if (phoneSuffix && !isOwnCompanyPhone(phoneSuffix[1])) {
              phone = phoneSuffix[1];
            }
          }
        }

        // Mobile/Cell/Direct — handles "Cell:", "Cell Phone:", "M ", "Mobile:", "Direct:", etc.
        // v3.18: Added "Direct" — convention: office=phone, direct/cell=mobile
        // v3.19: "Direct Line" handled above in phone regex; standalone "Direct" stays as mobile
        // v3.9: Skip own-company phone numbers
        if (!mobile) {
          const mobileMatch = line.match(/(?:\b(?:M(?:obile)?|C(?:ell(?:\s*Phone)?)?|Direct(?!\s+Line))\b|\((?:[mc])\))\s*[:|\s]*([\d(+][\d\s.()\-]{6,}\d)/i);
          if (mobileMatch) {
            const candidate = mobileMatch[1].replace(/\s*[\(]?(?:ext|x|extension)\.?\s*\d+\)?\s*$/i, '').trim();
            if (!isOwnCompanyPhone(candidate)) {
              mobile = candidate;
            }
          }
          // v3.18: Number-then-label pattern — "555.010.0110 direct"
          if (!mobile) {
            const mobileSuffix = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:direct|cell|mobile)\b/i);
            if (mobileSuffix && !isOwnCompanyPhone(mobileSuffix[1])) {
              mobile = mobileSuffix[1];
            }
          }
        }

        // v3.20 FIX: Standalone phone number fallback — lines that ARE just a phone number
        // e.g., "555.010.0107" on its own line in a signature block
        // Only triggers when no labeled phone was found yet. Must have 7+ digits, no letters.
        // Observed failure: a bank contact → "555.010.0107" line not captured (exec 460).
        if (!phone && !mobile) {
          const standalonePhone = line.match(/^([\d(+][\d\s.()\-]{6,}\d)\s*$/);
          if (standalonePhone) {
            const digits = standalonePhone[1].replace(/\D/g, '');
            if (digits.length >= 7 && digits.length <= 15 && !isOwnCompanyPhone(standalonePhone[1])) {
              phone = standalonePhone[1];
            }
          }
        }

        // Title: lines containing common title keywords
        // v3.20 FIX: Skip lines containing LLC/Inc/Corp/LLP/Ltd — those are company names, not titles
        // Observed failure: "Example Principal Advisors, LLC" matched as title (has "Principal"+"Advisors")
        if (!jobTitle && /(?:Director|President|Vice|Manager|Advisor|Officer|Partner|Principal|Chief|Counsel|Attorney|Senior|Associate|Analyst|Consultant|Specialist|Executive|Managing|Broker|Banker|Underwriter|Originator|Commercial|VP\b|SVP\b|EVP\b|AVP\b|Sr\b)/i.test(line)) {
          // Make sure it's a short title line, not a sentence, and not a company name
          if (line.length < 100 && !/[.!?]$/.test(line.trim()) && !/^(good|it was|i |please|looking|best|hi |hello|dear|just |thank|we |the )/i.test(line) && !/(?:LLC|Inc|Corp|LLP|Ltd|L\.?L\.?C|P\.?C)\b/i.test(line)) {
            jobTitle = line;
          }
        }

        // Company: lines that look like a company name
        // v3.19 FIX 3: Explicit "Company:" label prefix — highest priority company detection
        if (!companyName) {
          const companyLabel = line.match(/^(?:Company|Firm|Organization|Employer)\s*:\s*(.+)/i);
          if (companyLabel) {
            const val = companyLabel[1].trim();
            if (val.length > 1 && val.length < 80 && !isOwnBranding(val) && !isPhoneNumber(val)) {
              companyName = val;
            }
          }
        }
        // v3.11 FIX 4: Skip lines containing @ (email addresses) or URL patterns
        //   "JBROKER@EXAMPLE.BANK | EXAMPLELENDING.COM" contains "BANK" but is NOT a company name
        if (!companyName && line.length < 80 && line.length > 2) {
          if (/@/.test(line) || /^https?:\/\//i.test(line) || /^www\./i.test(line)) {
            // Skip — this is an email address or URL line, not a company name
          } else if ((line.match(/\|/g) || []).length >= 2) {
            // v3.12: SMART PIPE GUARD — pipe-separated lines are usually nav links
            // ("VIDEOS | CREDIT APPLICATION | CONTACT US") but could contain a
            // company name segment ("Home | Example Bank | Contact").
            // Check if any segment correlates with the email domain root before
            // rejecting the whole line. If a segment matches, extract just that segment.
            const domInfo = extractDomainRoot(extEmail);
            if (domInfo && domInfo.root.length >= 3) {
              const segments = line.split('|').map(s => s.trim()).filter(s => s.length > 0);
              const domSegment = segments.find(s => s.toLowerCase().includes(domInfo.root));
              if (domSegment && domSegment.length < 50 && !isOwnBranding(domSegment) && !isPhoneNumber(domSegment)) {
                companyName = domSegment;
              }
            }
            // If no domain match, skip the whole line (it's nav links)
          } else if (/(?:Bank|Capital|Financial|Group|Holdings|Securities|Partners|Advisors|Advisory|Wealth|Management|Corp|Inc|LLC|LLP|Associates|Enterprises|Insurance|Realty|Real Estate|Mortgage|Lending|Leasing|Credit|Trust|Fund|Investment|Asset|Global|National|American|Pacific|Atlantic|Southern|Northern|Western|Eastern|Equipment|Company|Properties|Development|Construction|Engineering|Technology|Systems)/i.test(line)) {
            // Make sure it's not a sentence, email header, or tagline
            // v3.16: Allow trailing "." for abbreviations (Inc., Ltd., Corp., Co.)
            const kwLineEndsPunct = /[.!?]$/.test(line.trim()) && !/(?:Inc|Ltd|Corp|Co|Jr|Sr|Esq|LLC|LLP|P\.?C|L\.?C)\.\s*$/i.test(line.trim());
            if (!/^(from|to|cc|date|subject|sent|good|hi |hello|please|thank|best|regard|we |the |a |mobile|office|fax|email|web|phone)/i.test(line) && !kwLineEndsPunct && !/^\d/.test(line)) {
              if (!isOwnBranding(line) && !isPhoneNumber(line)) {
                companyName = line;
              }
            }
          }
        }

        // ═══ v3.7 + v3.11: EMAIL-HINT-GUIDED NAME DETECTION ═══
        if (line.length < 60) {
          let candFirst = '', candLast = '', candNick = '';

          // Handle "Last, First" format
          // v3.19 FIX 2: Accept Unicode smart quotes (\u2018\u2019) in names like O'Broker
          const commaName = line.match(/^([A-Z][a-zA-Z'\u2018\u2019-]+),\s+([A-Z][a-zA-Z'\u2018\u2019-]+(?:\s+[A-Z]\.?)?)\s*$/);
          if (commaName) {
            candLast = commaName[1];
            candFirst = commaName[2].split(/\s+/)[0];
          } else {
            // Handle "First (Nick) Last" — e.g., "Jane (Janie) Broker"
            const nameWithNick = line.match(/^([A-Z][a-zA-Z'\u2018\u2019-]+)\s+\(([A-Za-z]+)\)\s+([A-Z][a-zA-Z'\u2018\u2019-]+)\s*$/);
            if (nameWithNick) {
              candFirst = nameWithNick[1];
              candNick = nameWithNick[2];
              candLast = nameWithNick[3];
            } else {
              // Handle "First M. Last" or "First Last"
              const nameLine = line.match(/^([A-Z][a-zA-Z'\u2018\u2019-]+)\s+(?:[A-Z]\.?\s+)?([A-Z][a-zA-Z'\u2018\u2019-]+)\s*$/);
              if (nameLine && !/^(From|To|Cc|Date|Subject|Sent|When|Where|Good|Best|Thank|Hi|Hello|Dear|Just|We|The|This|Please|Looking)/i.test(nameLine[1])) {
                candFirst = nameLine[1];
                candLast = nameLine[2];
              }
            }
          }

          if (candFirst && candLast) {
            // v3.11 FIX 6: Don't accept as name if it matches the company we already found
            const fullCand = (candFirst + ' ' + candLast).toLowerCase();
            if (companyName && fullCand === companyName.toLowerCase()) {
              // This line is the company name, not a person — skip
            } else if (nameHints && nameMatchesHints(candFirst, candLast, candNick, nameHints)) {
              // Hint-confirmed match — accept immediately
              firstName = candFirst;
              lastName = candLast;
              nickname = candNick;
            } else {
              // v3.11 FIX 2: Always overwrite fallback — farthest from email wins
              // In signatures, the person's name is at the TOP of the block (farthest
              // from email address). The company name is closer. By always overwriting,
              // we ensure "Jane Broker" (top) beats "Example Co" (middle).
              fallbackFirst = candFirst;
              fallbackLast = candLast;
              fallbackNick = candNick;
            }
          }
        }

        // City, State from address line — handles "City, ST 12345" and "City ST, 12345"
        // v3.10: REMOVED isOwnAddress guard — rely on phone blacklist only
        if (!city) {
          const cityState = line.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*,?\s*([A-Z]{2})\s*,?\s*\d{5}/);
          if (cityState) {
            city = cityState[1]; state = cityState[2];
          }
        }

        // v3.14: COUNTRY FIELD — detect country names in signature
        if (!country) {
          const countryMatch = line.match(/\b(TURKEY|CANADA|UNITED KINGDOM|UK|AUSTRALIA|GERMANY|FRANCE|BRAZIL|MEXICO|INDIA|JAPAN|CHINA|SOUTH KOREA|ITALY|SPAIN|NETHERLANDS|SWITZERLAND|SWEDEN|NORWAY|DENMARK|IRELAND|SINGAPORE|HONG KONG|NEW ZEALAND|ISRAEL|UAE|UNITED ARAB EMIRATES|QATAR|BAHRAIN|KUWAIT|SAUDI ARABIA|SOUTH AFRICA|CAYMAN ISLANDS|BERMUDA|BAHAMAS|COLOMBIA|CHILE|ARGENTINA|PERU)\b/i);
          if (countryMatch) {
            country = countryMatch[1];
          }
        }

        // v3.14: STATE/COUNTRY DISAMBIGUATION
        // If "state" value is actually a country name, move it to country
        if (state && !country) {
          const COUNTRIES = new Set(['turkey', 'canada', 'united kingdom', 'uk', 'australia', 'germany', 'france', 'brazil', 'mexico', 'india', 'japan', 'china', 'italy', 'spain', 'netherlands', 'switzerland', 'sweden', 'norway', 'denmark', 'ireland', 'singapore', 'hong kong', 'new zealand', 'israel', 'uae', 'united arab emirates', 'qatar', 'bahrain', 'kuwait', 'saudi arabia', 'south africa', 'cayman islands', 'bermuda', 'bahamas', 'colombia', 'chile', 'argentina', 'peru']);
          if (COUNTRIES.has(state.toLowerCase())) {
            country = state;
            state = '';
          }
        }
      }

      // v3.7: Name priority chain — hint-matched > header-extracted > fallback
      if (!firstName && headerFirst && headerLast) {
        firstName = headerFirst;
        lastName = headerLast;
      }
      if (!firstName && fallbackFirst) {
        firstName = fallbackFirst;
        lastName = fallbackLast;
        nickname = fallbackNick;
      }

      // Also scan lines AFTER the email for phone/address/company
      const afterLines = afterEmail.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (let i = 0; i < Math.min(afterLines.length, 15); i++) {
        const line = afterLines[i];
        if (/^(From:|To:|Cc:|Date:|Subject:|Sent:|-----)/i.test(line)) break;

        // v3.11 FIX 3: BOUNDARY — Stop scanning if we hit an own-company staff email
        // This prevents crossing from the contact's signature into the forwarder's own-company signature
        // and picking up the forwarder's city as the contact's city.
        // Only breaks on @yourcompany.com emails — NOT on other external emails,
        // because the forwarder sometimes pastes contact info in non-standard order with
        // multiple emails, personal backups, etc. We only need to guard against
        // the forwarder's own-company signature bleeding into the contact's data.
        const lineEmails = line.match(/[\w.+-]+@[\w.-]+\.\w{2,}/g) || [];
        const hitsOwnSig = lineEmails.some(e =>
          e.toLowerCase().endsWith('@yourcompany.com') ||
          e.toLowerCase() === (excludeForwarder || '').toLowerCase()
        );
        if (hitsOwnSig) break;

        // v3.9: Own-company phone guard applies to after-email scan too
        // v3.11 FIX 5: Same "P" prefix fix as above
        // v3.16: Bare vanity phone extraction
        if (!phone && !/\bCell\b/i.test(line)) {
          // v3.18: Removed "Direct" — now maps to mobile by convention (office=phone, direct=mobile)
          // v3.19 FIX 4: Added "Direct Line" — office phone, not mobile
          const phoneMatch = line.match(/(?:\b(?:T(?:el(?:ephone)?)?|P(?:h(?:one)?)?|O(?:ffice(?:\s*Phone)?)?|Business|Direct\s+Line)\b|\((?:[tpo])\))\s*[:|\s]*([\d(+][\d\s.()\-]{6,}\d)/i);
          if (phoneMatch) {
            const candidate = phoneMatch[1].replace(/\s*[\(]?(?:ext|x|extension)\.?\s*\d+\)?\s*$/i, '').trim();
            if (!isOwnCompanyPhone(candidate)) phone = candidate;
          }
          // v3.16: Bare vanity phone in after-email scan
          if (!phone) {
            const vanityMatch = line.match(/^(\(?\d{3}\)?[\s.\-]?\d{2,3}[\s.\-]?[A-Z]{2,}(?:\s*[-]\s*\([^)]+\))?)/i);
            if (vanityMatch) {
              const raw = vanityMatch[1].replace(/\s*[-]\s*\([^)]+\)\s*$/, '').trim();
              const vMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
              const normalized = raw.replace(/[A-Za-z]/g, ch => vMap[ch.toUpperCase()] || ch);
              const digits = normalized.replace(/\D/g, '');
              if (digits.length >= 7 && !isOwnCompanyPhone(normalized)) {
                phone = normalized;
              }
            }
          }
          // v3.18: Number-then-label pattern — "555.010.0109 office"
          if (!phone) {
            const phoneSuffix = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:office|business|main|work)\b/i);
            if (phoneSuffix && !isOwnCompanyPhone(phoneSuffix[1])) phone = phoneSuffix[1];
          }
        }
        if (!mobile) {
          // v3.18: Added "Direct" — convention: direct/cell=mobile
          // v3.19: Negative lookahead excludes "Direct Line" (handled by phone regex)
          const mobileMatch = line.match(/(?:\b(?:M(?:obile)?|C(?:ell(?:\s*Phone)?)?|Direct(?!\s+Line))\b|\((?:[mc])\))\s*[:|\s]*([\d(+][\d\s.()\-]{6,}\d)/i);
          if (mobileMatch) {
            const candidate = mobileMatch[1].replace(/\s*[\(]?(?:ext|x|extension)\.?\s*\d+\)?\s*$/i, '').trim();
            if (!isOwnCompanyPhone(candidate)) mobile = candidate;
          }
          // v3.18: Number-then-label pattern — "555.010.0110 direct"
          if (!mobile) {
            const mobileSuffix = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:direct|cell|mobile)\b/i);
            if (mobileSuffix && !isOwnCompanyPhone(mobileSuffix[1])) mobile = mobileSuffix[1];
          }
          // v3.16: Bare vanity as mobile (second vanity number in signature = mobile/toll-free)
          if (!mobile && phone) {
            const vanityMatch = line.match(/^(\(?\d{3}\)?[\s.\-]?\d{2,3}[\s.\-]?[A-Z]{2,}(?:\s*[-]\s*\([^)]+\))?)/i);
            if (vanityMatch) {
              const raw = vanityMatch[1].replace(/\s*[-]\s*\([^)]+\)\s*$/, '').trim();
              const vMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
              const normalized = raw.replace(/[A-Za-z]/g, ch => vMap[ch.toUpperCase()] || ch);
              const digits = normalized.replace(/\D/g, '');
              if (digits.length >= 7 && !isOwnCompanyPhone(normalized) && normalized !== phone) {
                mobile = normalized;
              }
            }
          }
        }
        // v3.11 FIX 3: City/state — same boundary applies (won't reach here if boundary hit above)
        if (!city) {
          const cityState = line.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*,?\s*([A-Z]{2})\s*,?\s*\d{5}/);
          if (cityState) {
            city = cityState[1]; state = cityState[2];
          }
        }
        // v3.11 FIX 4: Same @ guard for company in after-email scan
        // v3.12: Smart pipe guard + domain correlation (same as before-email scan)
        if (!companyName && line.length < 80 && line.length > 2) {
          if (/@/.test(line) || /^https?:\/\//i.test(line) || /^www\./i.test(line)) {
            // Skip — email/URL line
          } else if ((line.match(/\|/g) || []).length >= 2) {
            // v3.12: Smart pipe guard — check for domain-correlated segment first
            const domInfo = extractDomainRoot(extEmail);
            if (domInfo && domInfo.root.length >= 3) {
              const segments = line.split('|').map(s => s.trim()).filter(s => s.length > 0);
              const domSegment = segments.find(s => s.toLowerCase().includes(domInfo.root));
              if (domSegment && domSegment.length < 50 && !isOwnBranding(domSegment) && !isPhoneNumber(domSegment)) {
                companyName = domSegment;
              }
            }
          } else if (/(?:Bank|Capital|Financial|Group|Holdings|Securities|Partners|Advisors|Advisory|Wealth|Management|Corp|Inc|LLC|LLP|Associates|Enterprises|Insurance|Realty|Real Estate|Mortgage|Lending|Leasing|Credit|Trust|Fund|Investment|Asset|Global|National|American|Pacific|Atlantic|Southern|Northern|Western|Eastern|Equipment|Company|Properties|Development|Construction|Engineering|Technology|Systems)/i.test(line)) {
            // v3.16: Allow trailing "." for abbreviations (Inc., Ltd., Corp., Co.)
            const kwAfterEndsPunct = /[.!?]$/.test(line.trim()) && !/(?:Inc|Ltd|Corp|Co|Jr|Sr|Esq|LLC|LLP|P\.?C|L\.?C)\.\s*$/i.test(line.trim());
            if (!/^(from|to|cc|date|subject|sent|good|hi |hello|please|thank|best|regard|we |the |a |mobile|office|fax|email|web|phone)/i.test(line) && !kwAfterEndsPunct && !/^\d/.test(line)) {
              if (!isOwnBranding(line) && !isPhoneNumber(line)) {
                companyName = line;
              }
            }
          }
        }
      }

      // ═══ v3.12: THREE-LAYER COMPANY FALLBACK ═══
      // If keyword scanning didn't find a company name, try domain-based methods
      if (!companyName) {
        const domainInfo = extractDomainRoot(extEmail);
        if (domainInfo) {
          // Layer 1: Search lines for text correlating with the email domain
          // e.g., domain "example" → find line "Example Bank"
          const correlated = findDomainCorrelatedCompany(lines, domainInfo.root);
          if (correlated) {
            companyName = correlated;
          } else {
            // Also check after-email lines
            const afterLines = body.substring(emailIdx, Math.min(body.length, emailIdx + 500))
              .split('\n').map(l => l.trim()).filter(l => l.length > 0);
            const correlatedAfter = findDomainCorrelatedCompany(afterLines, domainInfo.root);
            if (correlatedAfter) {
              companyName = correlatedAfter;
            } else {
              // Layer 3: Synthesize from domain + TLD
              // e.g., "example" + ".bank" = "Example Bank"
              companyName = inferCompanyFromDomain(extEmail);
            }
          }
        }
      }

      // Score this extraction — pick the best one across all occurrences
      let score = 0;
      if (firstName) score += 3;
      if (lastName) score += 3;
      if (phone) score += 2;
      if (mobile) score += 2;
      if (jobTitle) score += 1;
      if (companyName) score += 1;
      if (city) score += 1;

      if (score > bestScore && (firstName || lastName)) {
        bestScore = score;
        bestContact = {
          // v3.9: Title Case normalization — "JANE BROKER" → "Jane Broker"
          firstName: toTitleCase(firstName),
          lastName: toTitleCase(lastName),
          nickname,
          email: extEmail,
          phone, mobile,
          companyName,
          // v3.9: Title Case for job titles too — "EQUIPMENT FINANCE MANAGER" → "Equipment Finance Manager"
          jobTitle: toTitleCase(jobTitle),
          city, state,
          address: '', country: country || '',
          website: '',
          type: '', specificType: '',
          confidence: 'high',
          extractionMethod: 'SIGNATURE_SCAN',
          infoNotes: ['Extracted via deterministic signature scan']
        };
      }
    }

    if (bestContact) {
      results.push(bestContact);
    }

    // ═══ v3.18: FROM-HEADER BODY SCAN FALLBACK ═══
    // When external email appears ONLY in From: header of a forwarded message (not in a
    // signature), the position loop above skips it. This fallback extracts the contact name
    // from the From: header and scans the forwarded email body for phone, address, company.
    // Observed failure: a contact (exec 424) — email only in "From: Jane Broker <jane@...>"
    if (!bestContact) {
      const esc = extEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const fromRe = new RegExp('From:[^\\n]*<?' + esc + '>?', 'i');
      const fMatch = body.match(fromRe);
      if (fMatch) {
        // Extract name from From: header
        const nameInFrom = fMatch[0].match(/From:\s*"?([^"<\n]+)"?\s*</i);
        let fbFirst = '', fbLast = '';
        if (nameInFrom) {
          const parts = nameInFrom[1].trim().split(/\s+/);
          if (parts.length >= 2) {
            fbFirst = parts[0];
            fbLast = parts[parts.length - 1];
          }
        }

        // Find the forwarded email body section (after Subject: line)
        const headerIdx = body.indexOf(fMatch[0]);
        const afterHeader = body.substring(headerIdx);
        const subjLine = afterHeader.match(/^Subject:.*$/m);
        const bodyStart = subjLine
          ? afterHeader.indexOf(subjLine[0]) + subjLine[0].length
          : fMatch[0].length;
        const bodySection = afterHeader.substring(bodyStart);

        // Find end boundary (next forwarding marker or disclaimer)
        const boundary = bodySection.match(/\n(?:-{5,}|_{5,}|={5,}|From:\s|---------- Forwarded|Begin forwarded|This e-?mail contains CONFIDENTIAL)/m);
        const endIdx = boundary ? bodySection.indexOf(boundary[0]) : bodySection.length;
        const scanText = bodySection.substring(0, Math.min(endIdx, 2000));
        const fbLines = scanText.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.length < 200);

        let fbPhone = '', fbMobile = '', fbCompany = '', fbTitle = '';
        let fbCity = '', fbState = '', fbCountry = '', fbWebsite = '';

        for (const line of fbLines) {
          if (/confidential|privilege|disclaimer/i.test(line)) continue;

          // Phone (label-before + number-before patterns)
          if (!fbPhone && !/\bCell\b/i.test(line)) {
            const pm1 = line.match(/(?:\b(?:T(?:el(?:ephone)?)?|P(?:h(?:one)?)?|O(?:ffice(?:\s*Phone)?)?|Business)\b|\((?:[tpo])\))\s*[:|\s]*([\d(+][\d\s.()\-]{6,}\d)/i);
            const pm2 = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:office|business|main|work)\b/i);
            const pm = pm1 || pm2;
            if (pm && !isOwnCompanyPhone(pm[1])) fbPhone = pm[1];
          }
          // Mobile/Direct
          if (!fbMobile) {
            const mm1 = line.match(/(?:\b(?:M(?:obile)?|C(?:ell(?:\s*Phone)?)?|Direct)\b|\((?:[mc])\))\s*[:|\s]*([\d(+][\d\s.()\-]{6,}\d)/i);
            const mm2 = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:direct|cell|mobile)\b/i);
            const mm = mm1 || mm2;
            if (mm && !isOwnCompanyPhone(mm[1])) fbMobile = mm[1];
          }
          // v3.20: Standalone phone fallback (same as primary scanner)
          if (!fbPhone && !fbMobile) {
            const sp = line.match(/^([\d(+][\d\s.()\-]{6,}\d)\s*$/);
            if (sp) {
              const digits = sp[1].replace(/\D/g, '');
              if (digits.length >= 7 && digits.length <= 15 && !isOwnCompanyPhone(sp[1])) {
                fbPhone = sp[1];
              }
            }
          }
          // City, State
          if (!fbCity) {
            const cs = line.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*,?\s*([A-Z]{2})\s*,?\s*\d{5}/);
            if (cs) { fbCity = cs[1]; fbState = cs[2]; }
          }
          // Country
          if (!fbCountry) {
            const cm = line.match(/\b(TURKEY|CANADA|UNITED KINGDOM|UK|AUSTRALIA|GERMANY|FRANCE|BRAZIL|MEXICO|INDIA|JAPAN|CHINA|SOUTH KOREA|ITALY|SPAIN|NETHERLANDS|SWITZERLAND|SWEDEN|NORWAY|DENMARK|IRELAND|SINGAPORE|HONG KONG|NEW ZEALAND|ISRAEL|UAE|UNITED ARAB EMIRATES|QATAR|BAHRAIN|KUWAIT|SAUDI ARABIA|SOUTH AFRICA|CAYMAN ISLANDS|BERMUDA|BAHAMAS|COLOMBIA|CHILE|ARGENTINA|PERU)\b/i);
            if (cm) fbCountry = cm[1];
          }
          // Website — v3.21: Exclude own-company domains
          if (!fbWebsite && /^(?:www\.|https?:\/\/)/i.test(line)) {
            const urlLower = line.trim().toLowerCase();
            const isOwnUrl = /yourcompany\.com/i.test(urlLower);
            if (!isOwnUrl) {
              fbWebsite = line.trim();
            }
          }
          // Company
          if (!fbCompany && line.length < 80 && line.length > 2) {
            if (!/@/.test(line) && !/^https?:\/\//i.test(line) && !/^www\./i.test(line) && !/^\d/.test(line)) {
              if (/(?:Bank|Capital|Financial|Group|Holdings|Securities|Partners|Advisors|Advisory|Wealth|Management|Corp|Inc|LLC|LLP|Associates|Enterprises|Insurance|Realty|Mortgage|Lending|Leasing|Credit|Trust|Fund|Investment|Asset|Global|National|Equipment|Company|Properties|Development|Construction|Engineering|Technology|Systems)/i.test(line)) {
                const endsWithPunct = /[.!?]$/.test(line.trim()) && !/(?:Inc|Ltd|Corp|Co|LLC|LLP)\.\s*$/i.test(line.trim());
                if (!endsWithPunct && !isOwnBranding(line) && !isPhoneNumber(line)) {
                  fbCompany = line;
                }
              }
            }
          }
          // Title
          // v3.20: Added LLC/Inc/Corp guard (same as primary scanner)
          if (!fbTitle && line.length < 100 && /(?:Director|President|Vice|Manager|Advisor|Officer|Partner|Principal|Chief|Counsel|Attorney|Senior|Associate|Analyst|Consultant|Specialist|Executive|Managing|Broker|Banker|Underwriter|Originator|VP\b|SVP\b|EVP\b)/i.test(line)) {
            if (!/[.!?]$/.test(line.trim()) && !/^(good|it was|please|looking|thank|we |the )/i.test(line) && !/(?:LLC|Inc|Corp|LLP|Ltd|L\.?L\.?C|P\.?C)\b/i.test(line)) {
              fbTitle = line;
            }
          }
        }

        // Company fallback from domain
        if (!fbCompany) {
          fbCompany = inferCompanyFromDomain(extEmail);
        }

        // Only create contact if we got a name + at least one useful field
        if (fbFirst && fbLast && (fbPhone || fbMobile || fbCompany)) {
          bestContact = {
            firstName: toTitleCase(fbFirst),
            lastName: toTitleCase(fbLast),
            nickname: '',
            email: extEmail,
            phone: fbPhone, mobile: fbMobile,
            companyName: fbCompany,
            jobTitle: toTitleCase(fbTitle),
            city: fbCity, state: fbState,
            address: '', country: fbCountry || '',
            website: fbWebsite,
            type: '', specificType: '',
            confidence: 'medium',
            extractionMethod: 'HEADER_BODY_SCAN',
            infoNotes: ['Contact extracted from forwarded email headers + body (no inline signature)']
          };
          results.push(bestContact);
        }
      }
    }
  }

  return { contacts: results, pendingTldLess: _pendingTldLess };
}

// v3.13: Use just the current item from the outer loop (not re-reading all items)
const items = [_item];
const results = [];


let _outerTldLessPending = []; // v3.30b: outer-scope for post-inner-for TLD resolution
for (const item of items) {
  const data = item.json;
  let jsonText = '';

  try {
    // ── Step 1: Extract raw text from AI response ──
    if (data.message && data.message.content) {
      jsonText = data.message.content;
    } else if (data.response) {
      jsonText = data.response;
    } else if (data.content) {
      jsonText = data.content;
    } else if (typeof data === 'string') {
      jsonText = data;
    } else {
      jsonText = JSON.stringify(data);
    }

    // ── Step 2: Strip markdown code fences ──
    jsonText = jsonText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim();

    // ── Step 3: Extract JSON from response text ──
    let jsonMatch = null;

    // Strategy A: Find outermost array [...]
    const arrayStart = jsonText.indexOf('[');
    const arrayEnd = jsonText.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      const candidate = jsonText.substring(arrayStart, arrayEnd + 1);
      try {
        JSON.parse(candidate);
        jsonMatch = candidate;
      } catch (e) {}
    }

    // Strategy B: Find outermost object {...}
    if (!jsonMatch) {
      const objStart = jsonText.indexOf('{');
      const objEnd = jsonText.lastIndexOf('}');
      if (objStart !== -1 && objEnd > objStart) {
        const candidate = jsonText.substring(objStart, objEnd + 1);
        try {
          JSON.parse(candidate);
          jsonMatch = candidate;
        } catch (e) {}
      }
    }

    // Strategy C: Try parsing the whole text as-is
    if (!jsonMatch) {
      try {
        JSON.parse(jsonText);
        jsonMatch = jsonText;
      } catch (e) {}
    }

    if (jsonMatch) jsonText = jsonMatch;

    // v3.12 CRITICAL FIX: Wrap JSON.parse in its own try-catch so the scanner
    // can still run when the AI returns prose instead of JSON. Previously, the
    // JSON.parse throw propagated to the outer catch which returned contacts: []
    // and the scanner (line ~718) never got a chance to execute.
    let parsed = null;
    let aiParseError = false;
    let aiErrorMessage = '';
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      aiParseError = true;
      aiErrorMessage = parseErr.message;
      // Don't throw — fall through so the scanner can run
    }

    // ── Step 4: Normalize to contacts array ──
    let contacts = [];
    if (parsed) {
      if (Array.isArray(parsed)) {
        contacts = parsed;
      } else if (parsed.contacts && Array.isArray(parsed.contacts)) {
        contacts = parsed.contacts;
      } else if (parsed.email || parsed.firstName || parsed.lastName || parsed.name) {
        contacts = [parsed];
      }
    }

    // Filter out any entries that are clearly not contact objects
    contacts = contacts.filter(c => c && typeof c === 'object' && !Array.isArray(c));

    // v3.20 FIX: Declare fullBody early — needed by v3.17 firstName header fallback (line ~1280)
    // Previously declared at line ~1345 (personal domain filter), causing ReferenceError
    // when any contact had empty firstName. Observed failure: a contact with empty firstName → 0 contacts (exec 458).
    const fullBody = prevData.fullBody || '';

    // ═══ FIELD NORMALIZATION — Map AI field names to pipeline field names ═══
    for (const contact of contacts) {
      // company → companyName (pipeline standard)
      if (contact.company && !contact.companyName) {
        contact.companyName = contact.company;
      }

      // title → jobTitle (pipeline standard)
      if (contact.title && !contact.jobTitle) {
        contact.jobTitle = contact.title;
      }

      // Handle "name" field → firstName + lastName
      if (contact.name && (!contact.firstName || !contact.lastName)) {
        const nameParts = contact.name.trim().split(/\s+/);
        if (nameParts.length >= 2) {
          contact.firstName = contact.firstName || nameParts[0];
          contact.lastName = contact.lastName || nameParts[nameParts.length - 1];
        } else if (nameParts.length === 1) {
          contact.lastName = contact.lastName || nameParts[0];
        }
      }

      // ═══ v3.15: CLEAR BAD COMPANY BEFORE PIPE SPLIT ═══
      // Must run before title-pipe split so the split can fire as fallback
      if (contact.companyName && (isOwnBranding(contact.companyName) || isPhoneNumber(contact.companyName))) {
        contact.companyName = '';
        contact.company = '';
      }

      // ═══ v3.15: AI-EXTRACTED COMPANY GUARD ═══
      // Guard BEFORE pipe split so pipe split can provide company as fallback
      if (contact.companyName && (isOwnBranding(contact.companyName) || isPhoneNumber(contact.companyName))) {
        contact.companyName = '';
        contact.company = '';
      }

      // ═══ v3.14 + v3.27: TITLE-PIPE SPLIT (name-aware) ═══
      // "Senior Sales Director | Example Brokers" → title = "Senior Sales Director", company = "Example Brokers"
      // "Jane Broker | Director | Finance | Example Co" → title = "Director", company = "Example Co"
      if (contact.jobTitle && contact.jobTitle.includes('|')) {
        const parts = contact.jobTitle.split('|').map(p => p.trim()).filter(p => p.length > 0);
        if (parts.length >= 2) {
          // v3.27: Check if first part is the contact's name — if so, skip it
          const _fullNameLower = ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim().toLowerCase();
          const _firstPartLower = parts[0].toLowerCase();
          const _lnLower = (contact.lastName || '').toLowerCase();
          const _titleKW = /\b(?:officer|director|president|manager|chief|head|lead|senior|junior|vice|vp|svp|evp|ceo|cfo|cto|coo|partner|counsel|advisor|analyst|specialist|coordinator|engineer|architect|consultant|associate|assistant)\b/i;
          // If first part contains a title keyword, it's NOT a name — safe to keep as title
          let _isNameFirst = false;
          if (!_titleKW.test(_firstPartLower)) {
            _isNameFirst = _fullNameLower && (
              _firstPartLower === _fullNameLower ||
              (_lnLower.length >= 3 && _firstPartLower.includes(_lnLower) && _firstPartLower.split(/\s+/).length <= 3)
            );
          }
          const _titleParts = _isNameFirst ? parts.slice(1) : parts;
          if (_titleParts.length >= 1) {
            contact.jobTitle = _titleParts[0];
            contact.title = _titleParts[0];
            if (!contact.companyName && !contact.company && _titleParts.length >= 2) {
              contact.companyName = _titleParts[_titleParts.length - 1];
              contact.company = _titleParts[_titleParts.length - 1];
            }
          }
        }
      }

      // ═══ v3.3: PHONE LABEL STRIPPING ═══
      function cleanPhoneLabel(phoneStr) {
        if (!phoneStr) return phoneStr;
        return phoneStr
          .replace(/\s*(?:office|direct|cell|mobile|home|work|fax|main|ext\.?\s*\d*)\s*$/i, '')
          .replace(/^\s*(?:office|direct|cell|mobile|home|work|fax|main)\s*[:.]\s*/i, '')
          .trim();
      }

      // phone: if it contains multiple numbers, split into phone + mobile
      if (contact.phone && !contact.mobile) {
        const phoneStr = contact.phone;
        const phoneNumbers = phoneStr.match(/[\d(+][\d\s.()\-]+\d/g) || [];
        if (phoneNumbers.length >= 2) {
          contact.phone = phoneNumbers[0].trim();
          contact.mobile = phoneNumbers[1].trim();
        } else {
          contact.phone = cleanPhoneLabel(contact.phone);
        }
      }
      if (contact.mobile) {
        contact.mobile = cleanPhoneLabel(contact.mobile);
      }

      // ═══ v3.3: JOB TITLE / TYPE ECHO DETECTION ═══
      if (contact.jobTitle && contact.type) {
        const titleNorm = contact.jobTitle.toLowerCase().trim();
        const typeNorm = contact.type.toLowerCase().trim();
        if (titleNorm === typeNorm) {
          contact.jobTitle = '';
          contact.title = '';
        }
      }

      // address: build from city/state if no explicit address
      if (!contact.address) {
        contact.address = '';
      }

      // country: default to empty if not provided
      if (!contact.country) {
        contact.country = '';
      }

      // website: leave empty for now — enriched below per-contact
      if (!contact.website) {
        contact.website = '';
      }

      // v3.9: Title Case normalization for AI-extracted names
      if (contact.firstName) contact.firstName = toTitleCase(contact.firstName);
      if (contact.lastName) contact.lastName = toTitleCase(contact.lastName);
      if (contact.jobTitle) contact.jobTitle = toTitleCase(contact.jobTitle);

      // v3.17: Fallback — extract name from email headers (From/To/Cc) when AI returns empty firstName
      if (!contact.firstName && contact.email) {
        const escEmail = contact.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const headerNameRe = new RegExp('(?:From|To|Cc):[^<]*?([A-Z][a-zA-Z.\'\\-]+(?:\\s+[A-Z][a-zA-Z.\'\\-]+)+)\\s*<?(?:[^<]*,\\s*)?<?["\']?' + escEmail, 'i');
        const hMatch = fullBody.match(headerNameRe);
        if (hMatch) {
          const rawName = hMatch[1].trim().replace(/^["']|["']$/g, '');
          const nameParts = rawName.split(/\s+/).filter(p => p.length > 0);
          if (nameParts.length >= 2) {
            contact.firstName = nameParts[0];
            contact.lastName = nameParts[nameParts.length - 1];
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('Name extracted from email header (AI returned empty firstName)');
          }
        }
      }

      // Ensure all expected fields exist (prevent undefined errors downstream)
      contact.firstName = contact.firstName || '';
      contact.lastName = contact.lastName || '';
      contact.email = contact.email || '';
      contact.phone = contact.phone || '';
      contact.mobile = contact.mobile || '';
      contact.companyName = contact.companyName || '';
      contact.jobTitle = contact.jobTitle || '';
      contact.city = contact.city || '';
      contact.state = contact.state || '';
      contact.address = contact.address || '';
      contact.country = contact.country || '';
      contact.type = contact.type || '';
      contact.specificType = contact.specificType || '';
      contact.confidence = contact.confidence || '';
      contact.website = contact.website || '';

      // v3.26: Strip trailing punctuation from names
      contact.firstName = (contact.firstName || '').replace(/[,;:]+$/, '').trim();
      contact.lastName = (contact.lastName || '').replace(/[,;:]+$/, '').trim();

      // v3.26: Detect "Last, First" pattern — e.g., "Broker, J." stored as firstName="Broker," lastName="J."
      // If firstName contains a comma, it's likely "Last, First" format — swap them
      if (contact.firstName && contact.firstName.includes(',')) {
        const parts = (contact.firstName + ' ' + contact.lastName).split(',').map(s => s.trim());
        if (parts.length === 2 && parts[0] && parts[1]) {
          contact.lastName = parts[0];  // "Broker"
          contact.firstName = parts[1]; // "J."
        }
      }

      // Clean up alias fields to avoid confusion
      if (contact.name) delete contact.name;

      // v3.25: Fix zip-in-state — if state looks like a zip code, move it to zip
      // and clear state. Do NOT try to infer state from city — many city names
      // exist in multiple states (Miami FL/OH/AZ, Portland OR/ME, etc.)
      if (contact.state && /^\d{4,5}(-\d{4})?$/.test(contact.state.trim())) {
        if (!contact.zip) contact.zip = contact.state;
        contact.state = '';
      }
      // Also catch state fields that are just numbers with spaces/dashes
      if (contact.state && /^\d[\d\s-]+$/.test(contact.state.trim())) {
        if (!contact.zip) contact.zip = contact.state.trim();
        contact.state = '';
      }
      // Validate state is a real state abbreviation or name (not a zip, phone, or junk)
      if (contact.state) {
        const s = contact.state.trim();
        // Valid: 2-letter abbreviation or full state/province name (3+ alpha chars)
        const isValidState = /^[A-Za-z]{2}$/.test(s) || (/^[A-Za-z\s]{3,}$/.test(s) && s.length <= 30);
        if (!isValidState) {
          // Not a recognizable state format — clear it
          contact.state = '';
        }
      }
    }

    // ═══ POST-PROCESSING: Filter out non-contacts ═══

    // 1. Remove contacts matching the forwarder's email
    const forwarderEmail = (prevData.forwarderEmail || '').toLowerCase();
    if (forwarderEmail) {
      contacts = contacts.filter(c => {
        const contactEmail = (c.email || '').toLowerCase();
        return contactEmail !== forwarderEmail;
      });
    }

    // 2. Remove any own-company internal emails the AI missed
    contacts = contacts.filter(c => {
      const contactEmail = (c.email || '').toLowerCase();
      return !contactEmail.endsWith('@yourcompany.com');
    });

    // 3. v3.12: Remove personal-email chain participants.
    //    When forwarderEmail is a shared inbox (intake@example.com),
    //    the actual person who forwarded (e.g., a personal gmail.com address) isn't
    //    caught by filter #1. But they're still a chain participant, not a contact.
    //
    //    We can't simply filter all From: header emails — legitimate external
    //    contacts like Jane Broker also appear in From: lines in the inner message.
    //
    //    TARGETED APPROACH: Filter contacts with PERSONAL email domains (gmail,
    //    yahoo, etc.) that appear in the forwarding chain headers. Business-domain
    //    contacts (example.bank, exampleco.com) are never caught by this.
    const PERSONAL_DOMAINS_FILTER = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
      'aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com','mail.com',
      'zoho.com','yandex.com','gmx.com','comcast.net','att.net','verizon.net']);
    // fullBody already declared earlier (v3.20 FIX)
    // Collect all emails from From:/Sent:/To: header lines
    const chainEmails = new Set();
    const headerLineRegex = /^(?:From|Sent|To)\s*:.*$/gim;
    let headerMatch;
    while ((headerMatch = headerLineRegex.exec(fullBody)) !== null) {
      const lineEmails = headerMatch[0].match(/[\w.+-]+@[\w.-]+\.\w{2,}/g) || [];
      for (const he of lineEmails) chainEmails.add(he.toLowerCase());
    }
    contacts = contacts.filter(c => {
      const contactEmail = (c.email || '').toLowerCase();
      if (!contactEmail) return true;
      const domain = contactEmail.split('@')[1] || '';
      // Only filter PERSONAL domain emails that appear in chain headers
      // Business domains (example.bank, etc.) are never filtered here
      if (PERSONAL_DOMAINS_FILTER.has(domain) && chainEmails.has(contactEmail)) {
        return false; // Personal email in forwarding chain = not an external contact
      }
      return true;
    });

    // ═══════════════════════════════════════════════════════════════
    // v3.6: ALWAYS-ON SIGNATURE SCANNER + AI MERGE
    // ═══════════════════════════════════════════════════════════════

    const _scanResult = scanSignatures(prevData.fullBody || '', forwarderEmail);
    const scannedContacts = _scanResult.contacts || _scanResult; // backward compat
    _outerTldLessPending = _scanResult.pendingTldLess || [];

    // Build map of AI contacts by email (lowercase)
    const aiByEmail = new Map();
    const aiNoEmail = [];
    for (const ai of contacts) {
      const key = (ai.email || '').toLowerCase();
      if (key) {
        aiByEmail.set(key, ai);
      } else {
        aiNoEmail.push(ai);
      }
    }

    // Merge: scanner contacts are primary, AI contacts are supplementary
    const mergedByEmail = new Map();

    // Add scanner contacts first (authoritative for name/phone)
    for (const sc of scannedContacts) {
      const key = sc.email.toLowerCase();
      const ai = aiByEmail.get(key);

      if (ai) {
        // Both found this contact — merge (scanner wins for name/phone, AI wins for type)
        // v3.19 FIX 1: If scanner's name matches the job title, it's a misidentified title — prefer AI
        let useFirstName = sc.firstName || ai.firstName;
        let useLastName = sc.lastName || ai.lastName;
        if (sc.firstName && sc.lastName && sc.jobTitle) {
          const scannerFullName = (sc.firstName + ' ' + sc.lastName).toLowerCase().trim();
          const titleLower = sc.jobTitle.toLowerCase().trim();
          if (scannerFullName === titleLower && ai.firstName) {
            useFirstName = ai.firstName;
            useLastName = ai.lastName || sc.lastName;
          }
        }
        mergedByEmail.set(key, {
          firstName: useFirstName,
          lastName: useLastName,
          email: sc.email,
          phone: sc.phone || ai.phone,
          mobile: sc.mobile || ai.mobile,
          companyName: sc.companyName || ai.companyName,
          jobTitle: sc.jobTitle || ai.jobTitle,
          city: sc.city || ai.city,
          state: sc.state || ai.state,
          address: ai.address || '',
          country: sc.country || ai.country || '',
          website: ai.website || sc.website || '',
          type: ai.type || '',
          specificType: ai.specificType || '',
          confidence: 'high',
          extractionMethod: 'MERGED_SCAN_AND_AI',
          infoNotes: ['Contact verified by both signature scan and AI extraction'],
          nickname: sc.nickname || ''
        });
        aiByEmail.delete(key); // Mark as merged
      } else {
        // Scanner-only contact (AI missed it entirely)
        mergedByEmail.set(key, {
          ...sc,
          extractionMethod: 'SIGNATURE_SCAN',
          infoNotes: ['Extracted via signature scan (AI missed this contact)']
        });
      }
    }

    // Add remaining AI-only contacts (scanner didn't find them)
    for (const [key, ai] of aiByEmail) {
      mergedByEmail.set(key, {
        ...ai,
        extractionMethod: ai.extractionMethod || 'AI_ONLY'
      });
    }

    // v3.22: Deduplicate no-email AI contacts against scanner contacts by name
    const alreadyMergedNames = new Set(
      [...mergedByEmail.values()].map(c => ((c.firstName || '') + ' ' + (c.lastName || '')).toLowerCase().trim())
    );
    const dedupedNoEmail = aiNoEmail.filter(c => {
      const key = ((c.firstName || '') + ' ' + (c.lastName || '')).toLowerCase().trim();
      return key && !alreadyMergedNames.has(key);
    });
    contacts = [...mergedByEmail.values(), ...dedupedNoEmail];

    // v3.26: Full name-based dedup — when multiple contacts share the same name,
    // keep the one with the best data. Fixes triple-duplicate bug (#661).
    const nameGroups = new Map();
    for (const c of contacts) {
      const key = ((c.firstName || '') + ' ' + (c.lastName || '')).toLowerCase().trim();
      if (!key) continue;
      if (!nameGroups.has(key)) nameGroups.set(key, []);
      nameGroups.get(key).push(c);
    }
    contacts = [];
    for (const [name, group] of nameGroups) {
      if (group.length === 1) {
        contacts.push(group[0]);
        continue;
      }
      // Score each: prefer non-generic email, most fields, highest confidence
      const scored = group.map(c => {
        let score = 0;
        const email = (c.email || '').toLowerCase();
        const localPart = email.split('@')[0] || '';
        const genericPrefixes = ['info','sales','support','admin','contact','help','billing',
          'noreply','no-reply','fraud','abuse','spam','security','postmaster','webmaster'];
        if (email && !genericPrefixes.includes(localPart)) score += 10;
        if (c.phone) score += 2;
        if (c.mobile) score += 2;
        if (c.companyName) score += 2;
        if (c.jobTitle) score += 2;
        if (c.city) score += 1;
        if (c.website) score += 1;
        if (c.confidence === 'high') score += 3;
        else if (c.confidence === 'medium') score += 1;
        return { contact: c, score };
      });
      scored.sort((a, b) => b.score - a.score);
      // Keep the best, merge any unique fields from others into it
      const best = { ...scored[0].contact };
      for (let i = 1; i < scored.length; i++) {
        const other = scored[i].contact;
        if (!best.phone && other.phone) best.phone = other.phone;
        if (!best.mobile && other.mobile) best.mobile = other.mobile;
        if (!best.companyName && other.companyName) best.companyName = other.companyName;
        if (!best.jobTitle && other.jobTitle) best.jobTitle = other.jobTitle;
        if (!best.website && other.website) best.website = other.website;
        if (!best.city && other.city) best.city = other.city;
        if (!best.state && other.state) best.state = other.state;
        if (!best.country && other.country) best.country = other.country;
      }
      contacts.push(best);
    }
    // Also add back any contacts that had no name (anonymous/email-only)
    for (const c of [...mergedByEmail.values(), ...dedupedNoEmail]) {
      const key = ((c.firstName || '') + ' ' + (c.lastName || '')).toLowerCase().trim();
      if (!key && !contacts.includes(c)) contacts.push(c);
    }

    // ═══ v3.21 FIX: AI NARRATIVE HEADER FALLBACK ═══
    // When AI returned narrative text (not JSON) and mentioned email addresses that the
    // scanner missed because they only appear on From:/To:/Cc: header lines, extract
    // those contacts as a fallback. Observed failure: header-only contact (exec 577).
    if (aiParseError && jsonText) {
      const narrativeEmailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
      const narrativeEmails = (jsonText.match(narrativeEmailRegex) || []);
      const existingEmails = new Set(contacts.map(c => (c.email || '').toLowerCase()));
      const OWN_DOMAINS_FALLBACK = new Set(['yourcompany.com', 'example-consultancy.com']);
      const PERSONAL_DOMAINS_FALLBACK = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com']);

      for (const nEmail of narrativeEmails) {
        const nEmailLower = nEmail.toLowerCase();
        const nDomain = nEmailLower.split('@')[1] || '';
        // Skip if already found, or internal/personal
        if (existingEmails.has(nEmailLower)) continue;
        if (OWN_DOMAINS_FALLBACK.has(nDomain)) continue;
        if (PERSONAL_DOMAINS_FALLBACK.has(nDomain)) continue;
        if (nEmailLower === (forwarderEmail || '').toLowerCase()) continue;

        // Check if this email exists anywhere in the original email body (even on header lines)
        const bodyCheck = (prevData.fullBody || '').toLowerCase();
        if (!bodyCheck.includes(nEmailLower)) continue;

        // Try to extract name from the header line where this email appears
        let fallbackFirst = '', fallbackLast = '';
        const escapedNEmail = nEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match patterns like: "LASTNAME FirstName <email>" or "FirstName LastName <email>"
        const headerNameRegex = new RegExp('(?:From|To|Cc|Bcc)\\s*:[^\\n]*?([^"<,;\\n]+?)\\s*<?\\s*' + escapedNEmail, 'im');
        const headerNameMatch = (prevData.fullBody || '').match(headerNameRegex);
        if (headerNameMatch) {
          const rawName = headerNameMatch[1].trim().replace(/^["']|["']$/g, '');
          // Handle "LASTNAME FirstName" (all-caps last name pattern) and "FirstName LastName"
          const nameParts = rawName.split(/\s+/).filter(p => p.length > 0);
          if (nameParts.length >= 2) {
            // Check if first part is all uppercase (European style: LASTNAME FirstName)
            if (nameParts[0] === nameParts[0].toUpperCase() && nameParts[0].length > 1) {
              fallbackLast = nameParts[0].charAt(0) + nameParts[0].slice(1).toLowerCase();
              // Handle hyphenated last names like "SMITH-JONES"
              fallbackLast = nameParts.slice(0, -1).map(p =>
                p.split('-').map(seg => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase()).join('-')
              ).join(' ');
              fallbackFirst = nameParts[nameParts.length - 1].charAt(0).toUpperCase() +
                nameParts[nameParts.length - 1].slice(1).toLowerCase();
            } else {
              fallbackFirst = nameParts[0];
              fallbackLast = nameParts.slice(1).join(' ');
            }
          }
        }

        contacts.push({
          firstName: fallbackFirst,
          lastName: fallbackLast,
          nickname: '',
          email: nEmail,
          phone: '', mobile: '',
          companyName: '',
          jobTitle: '',
          city: '', state: '', address: '', country: '',
          website: '',
          type: '', specificType: '',
          confidence: 'medium',
          extractionMethod: 'AI_NARRATIVE_HEADER_FALLBACK',
          infoNotes: ['Contact extracted from AI narrative text + email header (scanner skipped header-only emails)']
        });
        existingEmails.add(nEmailLower);
      }
    }

    // v3.26: Post-merge title/company cleanup
    const TITLE_KEYWORDS = /president|director|manager|officer|founder|partner|member|professional|advisor|broker|sales|marketing|vp|svp|ceo|cfo|coo|cto|licensed|managing|senior|executive|associate|consultant|specialist|principal|chairman|head|lead|coordinator/i;

    for (const contact of contacts) {
      // Fix 3a: Pipe-split in title or company fields
      const pipeFields = ['jobTitle', 'companyName'];
      for (const field of pipeFields) {
        const val = contact[field] || '';
        if (val.includes(' | ') || val.includes(' | ')) {
          const parts = val.split(/\s*[|]\s*/);
          if (parts.length === 2) {
            const hasTitleA = TITLE_KEYWORDS.test(parts[0]);
            const hasTitleB = TITLE_KEYWORDS.test(parts[1]);
            if (hasTitleA && !hasTitleB) {
              contact.jobTitle = parts[0];
              if (!contact.companyName || contact.companyName === val) contact.companyName = parts[1];
            } else if (hasTitleB && !hasTitleA) {
              contact.jobTitle = parts[1];
              if (!contact.companyName || contact.companyName === val) contact.companyName = parts[0];
            }
          }
        }
      }

      // Fix 3b: Company === Title — clear company, derive from domain
      if (contact.companyName && contact.jobTitle &&
          contact.companyName.trim().toLowerCase() === contact.jobTitle.trim().toLowerCase()) {
        // Title is more likely correct for role descriptions
        contact.companyName = '';
        // Try to derive company from email domain
        if (contact.email) {
          const domain = contact.email.split('@')[1] || '';
          if (domain) {
            const domainBase = domain.split('.')[0];
            if (domainBase && domainBase.length > 2) {
              // Capitalize: "examplebank" → "Examplebank"
              contact.companyName = domainBase.charAt(0).toUpperCase() + domainBase.slice(1);
            }
          }
        }
      }

      // Fix 3c: Company is the person's name — clear it
      if (contact.companyName && contact.firstName && contact.lastName) {
        const compLower = contact.companyName.toLowerCase().trim();
        const nameLower = (contact.firstName + ' ' + contact.lastName).toLowerCase().trim();
        const nameReversed = (contact.lastName + ' ' + contact.firstName).toLowerCase().trim();
        if (compLower === nameLower || compLower === nameReversed ||
            compLower.startsWith(nameLower + ' |') || compLower.startsWith(nameReversed + ' |')) {
          contact.companyName = '';
          // Derive from domain
          if (contact.email) {
            const domain = contact.email.split('@')[1] || '';
            const domainBase = domain.split('.')[0] || '';
            if (domainBase && domainBase.length > 2) {
              contact.companyName = domainBase.charAt(0).toUpperCase() + domainBase.slice(1);
            }
          }
        }
      }
    }

    // v3.26: Drop incomplete PDF OCR duplicates
    // If a PDF_OCR contact has no lastName AND no email, and another contact
    // shares the same firstName with higher confidence, drop the OCR contact
    contacts = contacts.filter((c, idx) => {
      if (c.extractionMethod !== 'PDF_OCR') return true;
      if (c.lastName && c.email) return true; // Has enough data, keep it
      if (!c.firstName) return false; // No name at all, drop

      const fnLower = c.firstName.toLowerCase();
      const hasBetterDuplicate = contacts.some((other, otherIdx) => {
        if (otherIdx === idx) return false;
        if (other.extractionMethod === 'PDF_OCR') return false; // Don't compare OCR to OCR
        return (other.firstName || '').toLowerCase() === fnLower;
      });

      if (hasBetterDuplicate && (!c.lastName || !c.email)) {
        return false; // Drop this incomplete OCR contact
      }
      return true;
    });

    // ═══ v3.16: POST-MERGE COMPANY GUARD + PIPE SPLIT ═══
    // The merge may have restored bad company values from the scanner.
    // Re-apply the same guards that ran during normalization.
    for (const contact of contacts) {
      // Guard: clear own-company branding or phone-number company
      if (contact.companyName && (isOwnBranding(contact.companyName) || isPhoneNumber(contact.companyName))) {
        contact.companyName = '';
        contact.company = '';
      }
      // Re-apply pipe split on jobTitle if company is empty (v3.27: name-aware)
      if (contact.jobTitle && contact.jobTitle.includes('|') && !contact.companyName) {
        const pipeParts = contact.jobTitle.split('|').map(p => p.trim()).filter(p => p.length > 0);
        if (pipeParts.length >= 2) {
          const _fn2 = ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim().toLowerCase();
          const _ln2 = (contact.lastName || '').toLowerCase();
          const _fp2 = pipeParts[0].toLowerCase();
          const _tkw2 = /\b(?:officer|director|president|manager|chief|head|lead|senior|junior|vice|vp|svp|evp|ceo|cfo|cto|coo|partner|counsel|advisor|analyst|specialist|coordinator|engineer|architect|consultant|associate|assistant)\b/i;
          let _isName = false;
          if (!_tkw2.test(_fp2)) {
            _isName = _fn2 && (
              _fp2 === _fn2 ||
              (_ln2.length >= 3 && _fp2.includes(_ln2) && _fp2.split(/\s+/).length <= 3)
            );
          }
          const _tParts = _isName ? pipeParts.slice(1) : pipeParts;
          if (_tParts.length >= 1) {
            contact.jobTitle = _tParts[0];
            contact.title = _tParts[0];
            if (_tParts.length >= 2) {
              contact.companyName = _tParts[_tParts.length - 1];
              contact.company = _tParts[_tParts.length - 1];
            }
          }
        }
      }
    }

    // ═══ v3.6 + v3.16: PHONE/MOBILE SANITY CHECK ═══
    // v3.16: Count vanity letters as digits for validation (DEAL=3325 = 4 more digits)
    function countPhoneDigits(phoneStr) {
      if (!phoneStr) return 0;
      const vanityMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
      const converted = phoneStr.replace(/[A-Za-z]/g, ch => vanityMap[ch.toUpperCase()] || ch);
      return converted.replace(/\D/g, '').length;
    }
    // v3.16: Normalize vanity phone to digits for Zoho storage
    function normalizeVanityPhone(phoneStr) {
      if (!phoneStr) return phoneStr;
      // Only convert if it contains a mix of digits and letters in phone-like pattern
      if (!/^[\d(+]/.test(phoneStr.trim())) return phoneStr;
      const vanityMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
      return phoneStr.replace(/[A-Za-z]/g, ch => vanityMap[ch.toUpperCase()] || ch);
    }
    for (const contact of contacts) {
      if (contact.phone) {
        // v3.17: Block own-company staff phones from leaking into contact records
        if (isOwnCompanyPhone(contact.phone)) {
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Cleared own-company internal phone "' + contact.phone + '"');
          contact.clearedFields = contact.clearedFields || [];
          contact.clearedFields.push({ field: 'phone', hadValue: contact.phone, reason: 'Own-company internal phone' });
          contact.phone = '';
        } else {
          const digits = countPhoneDigits(contact.phone);
          if (digits < 7) {
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('Cleared invalid phone "' + contact.phone + '" (too few digits — likely truncated)');
            contact.phone = '';
          } else {
            // Normalize vanity letters to digits for storage
            contact.phone = normalizeVanityPhone(contact.phone);
          }
        }
      }
      if (contact.mobile) {
        // v3.17: Block own-company staff phones from leaking into contact records
        if (isOwnCompanyPhone(contact.mobile)) {
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Cleared own-company internal mobile "' + contact.mobile + '"');
          contact.clearedFields = contact.clearedFields || [];
          contact.clearedFields.push({ field: 'mobile', hadValue: contact.mobile, reason: 'Own-company internal phone' });
          contact.mobile = '';
        } else {
          const digits = countPhoneDigits(contact.mobile);
          if (digits < 7) {
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('Cleared invalid mobile "' + contact.mobile + '" (too few digits — likely an extension)');
            contact.mobile = '';
          } else {
            contact.mobile = normalizeVanityPhone(contact.mobile);
          }
        }
      }
    }

    // ═══ v3.27: PHONE DEDUP ═══
    // If phone and mobile are the same number, clear mobile
    for (const contact of contacts) {
      if (contact.phone && contact.mobile) {
        const _phoneD = contact.phone.replace(/\D/g, '');
        const _mobileD = contact.mobile.replace(/\D/g, '');
        if (_phoneD === _mobileD) {
          contact.mobile = '';
        }
      }
    }

    // ═══ v3.27: GHOST CONTACT FILTER ═══
    // Remove contacts with very short names and no email (AI parsing artifacts like "Wiz", "Wry")
    contacts = contacts.filter(c => {
      const _fn = (c.firstName || '').trim();
      const _ln = (c.lastName || '').trim();
      const _hasEmail = !!(c.email || '').trim();
      if (_fn.length <= 3 && _ln.length === 0 && !_hasEmail) return false;
      if (_fn.length <= 2 && _ln.length <= 2) return false;
      return true;
    });

    // 3. Apply suggestedType override from forwarder's instruction
    const suggestedType = prevData.suggestedType || '';
    if (suggestedType) {
      for (const contact of contacts) {
        contact.originalAiType = contact.type || '';
        contact.type = suggestedType;
        contact.typeSource = 'forwarder_hint';
      }
    }

    // 3a. OWN-COMPANY STAFF NAME EXCLUSION — catch when AI extracts internal staff
    // Populate with the firm's own staff so their signatures are never extracted as contacts.
    const OWN_EMPLOYEE_FIRST_NAMES = new Set(['alex', 'pat', 'taylor', 'morgan', 'casey']);
    const OWN_EMPLOYEE_LAST_NAMES = new Set(['example', 'sample', 'placeholder', 'demo']);
    const OWN_BLOCKED_DOMAINS = new Set(['yourcompany.com', 'example-consultancy.com']);
    
    contacts = contacts.filter(contact => {
      const fName = (contact.firstName || '').toLowerCase().trim();
      const lName = (contact.lastName || '').toLowerCase().trim();
      const cEmail = (contact.email || '').toLowerCase();
      const cDomain = cEmail.split('@')[1] || '';
      const company = (contact.companyName || contact.company || '').toLowerCase();
      
      // Block by email domain (own company + known hallucinated variants)
      if (OWN_BLOCKED_DOMAINS.has(cDomain)) {
        console.log('Excluded own-company/hallucinated domain: ' + cEmail);
        return false;
      }
      
      // Block by full name match
      if (fName && lName && OWN_EMPLOYEE_FIRST_NAMES.has(fName) && OWN_EMPLOYEE_LAST_NAMES.has(lName)) {
        console.log('Excluded own-company staff by name: ' + fName + ' ' + lName);
        return false;
      }
      
      // Block partial name + own-company context
      const isOwnCompany = /yourcompany|your\s+company/i.test(company);
      if (isOwnCompany) {
        // If company is own-company-related, this is almost certainly an internal employee
        console.log('Excluded own-company contact: ' + fName + ' ' + lName + ' at ' + company);
        return false;
      }
      
      // Block single-name matches when combined with own-company context
      // (catches a staff first name with no last name, or a staff last name with no first name, when from own-company context)
      const isSingleEmployeeName = (!fName && OWN_EMPLOYEE_LAST_NAMES.has(lName)) || 
                                    (!lName && OWN_EMPLOYEE_FIRST_NAMES.has(fName));
      if (isSingleEmployeeName && (isOwnCompany || !cEmail || cDomain === '')) {
        console.log('Excluded likely own-company staff (partial name): ' + fName + ' ' + lName);
        return false;
      }
      
      return true;
    });

    // 3a1b. DISTRIBUTION CHANNEL EMAIL FILTER
    // Emails from newsletter/listing platforms are NOT real contacts.
    // When the forwarder sends "Acme Holdings via a listing platform", the contact is Acme Holdings,
    // not listings@example.com. Filter these out so the real broker can be found.
    const DISTRIBUTION_CHANNEL_DOMAINS = new Set([
      'jato.com', 'send.example-broker.com',
      'notifications.hubspot.com', 'communication.microsoft.com'
    ]);
    const DISTRIBUTION_CHANNEL_PREFIXES = new Set([
      'noreply', 'no-reply', 'info=', 'newsletter', 'notifications', 'feedback'
    ]);
    
    const preChannelCount = contacts.length;
    contacts = contacts.filter(contact => {
      const email = (contact.email || '').toLowerCase();
      if (!email) return true; // Keep contacts without email (name-only)
      const domain = email.split('@')[1] || '';
      const localPart = email.split('@')[0] || '';
      
      if (DISTRIBUTION_CHANNEL_DOMAINS.has(domain)) {
        console.log('Filtered distribution channel: ' + email);
        return false;
      }
      if (DISTRIBUTION_CHANNEL_PREFIXES.has(localPart.split('=')[0])) {
        console.log('Filtered noreply/newsletter: ' + email);
        return false;
      }
      return true;
    });
    
    // If ALL contacts were filtered (only channel addresses found), 
    // and there's a real company name in the body, flag for web research
    if (preChannelCount > 0 && contacts.length === 0) {
      // The email had contacts but they were all distribution channels.
      // The REAL contact is the company behind the listing.
      // Web Research will pick this up via the DISTRIBUTION_CHANNEL_TARGET classification.
    }

    // 3a2. OWN-COMPANY SIGNATURE GUARD — catch when scanner grabs own-company tagline as company
    const OWN_COMPANY_PATTERNS = [
      /your\s+company\s+tagline\s+here/i,
      /yourcompany/i,
      /your\s+company/i,
      /anytown,?\s+st\s+00000/i
    ];
    for (const contact of contacts) {
      const comp = contact.companyName || contact.company || '';
      if (comp && OWN_COMPANY_PATTERNS.some(p => p.test(comp))) {
        // Try to derive real company from email domain
        const email = contact.email || '';
        const domain = email.split('@')[1] || '';
        const domainBase = domain.split('.')[0] || '';
        if (domain && !['gmail.com','hotmail.com','icloud.com','yahoo.com'].includes(domain)) {
          // v3.21: Smart word splitting for domain-derived company names
          // e.g. "acmeproperties" → "Acme Properties"
          const bizWords = ['properties','capital','financial','group','holdings',
            'securities','partners','advisors','advisory','wealth','management','solutions',
            'corp','enterprises','insurance','realty','mortgage','lending',
            'leasing','credit','trust','fund','investment','asset','global','national',
            'equipment','company','development','construction','engineering','technology',
            'systems','services','industries','consulting',
            'air','broker','sales','energy','media',
            'design','logistics','transport','trading','supply','resources','associates'];
          let companyFromDomain = domainBase;
          for (const bw of bizWords) {
            const idx = domainBase.toLowerCase().indexOf(bw);
            if (idx > 0 && idx + bw.length === domainBase.length) {
              const prefix = domainBase.substring(0, idx);
              companyFromDomain = prefix.charAt(0).toUpperCase() + prefix.slice(1) + ' ' + bw.charAt(0).toUpperCase() + bw.slice(1);
              break;
            }
          }
          if (companyFromDomain === domainBase) {
            companyFromDomain = domainBase.charAt(0).toUpperCase() + domainBase.slice(1);
          }
          contact.companyName = companyFromDomain;
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Company corrected from own-company tagline to "' + contact.companyName + '" (derived from email domain)');
        } else {
          contact.companyName = '';
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Cleared own-company tagline from company field');
        }
      }
    }

    // 3b. TITLE-AS-NAME GUARD — catch when AI puts title in name fields
    // e.g., firstName: "Vice", lastName: "President" or firstName: "Director", lastName: "of Sales"
    const TITLE_PATTERNS = [
      /^(?:vice|senior|junior|executive|assistant|associate|managing|regional|chief)$/i,
      /^(?:president|director|manager|officer|partner|chairman|founder|ceo|cfo|coo|cto|svp|evp|vp|avp)$/i,
      /^(?:of|the|and|for)$/i
    ];
    const FULL_TITLE_PATTERNS = [
      /^vice\s+president$/i, /^managing\s+director$/i, /^sales\s+director$/i,
      /^director\s+of\s+/i, /^senior\s+vice\s+president$/i, /^assistant\s+vice\s+president$/i,
      /^chief\s+\w+\s+officer$/i, /^regional\s+(?:sales\s+)?director$/i,
      /^executive\s+vice\s+president$/i, /^sr\.?\s+vice\s+president$/i,
      /^evp[,\s]/i, /^svp[,\s]/i, /^vp[,\s]/i
    ];
    
    for (const contact of contacts) {
      const fullName = ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim();
      const isTitleAsName = FULL_TITLE_PATTERNS.some(p => p.test(fullName)) ||
        (TITLE_PATTERNS.some(p => p.test(contact.firstName || '')) && TITLE_PATTERNS.some(p => p.test(contact.lastName || '')));
      
      if (isTitleAsName && contact.email) {
        // Try to recover real name from email local part
        const local = contact.email.split('@')[0].replace(/[._-]/g, ' ').trim();
        const parts = local.split(/\s+/);
        if (parts.length >= 2) {
          const recoveredFirst = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
          const recoveredLast = parts[parts.length - 1].charAt(0).toUpperCase() + parts[parts.length - 1].slice(1).toLowerCase();
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Name recovered from email: AI returned "' + fullName + '" (title, not name) → corrected to "' + recoveredFirst + ' ' + recoveredLast + '"');
          // Move the original values to title if title is empty
          if (!contact.jobTitle && fullName.length > 3) {
            contact.jobTitle = fullName;
          }
          contact.firstName = recoveredFirst;
          contact.lastName = recoveredLast;
        } else {
          // Can't recover from email — flag for review
          contact.needsReview = true;
          contact.reviewReason = (contact.reviewReason ? contact.reviewReason + ' | ' : '') + 
            'TITLE_AS_NAME: AI extracted "' + fullName + '" as name — likely a title, not a person name';
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Possible title extracted as name: "' + fullName + '"');
        }
      }
    }

    // 4. Cap contacts at 15 per email to prevent API flooding
    const MAX_CONTACTS = 15;
    if (contacts.length > MAX_CONTACTS) {
      const excess = contacts.length - MAX_CONTACTS;
      contacts = contacts.slice(0, MAX_CONTACTS);
      contacts[MAX_CONTACTS - 1].infoNotes = contacts[MAX_CONTACTS - 1].infoNotes || [];
      contacts[MAX_CONTACTS - 1].infoNotes.push(excess + ' additional contact(s) found but capped at ' + MAX_CONTACTS + ' — add remaining manually');
    }

    // ═══ v3.3: SMART WEBSITE ENRICHMENT ═══
    const personalDomains = ['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com'];

    // v3.21: Own-company domains excluded from auto-website
    const ownDomains = ['yourcompany.com'];
    for (const contact of contacts) {
      if (!contact.website && contact.email) {
        const domain = contact.email.split('@')[1];
        if (domain && !personalDomains.includes(domain.toLowerCase()) && !ownDomains.includes(domain.toLowerCase())) {
          contact.website = 'https://' + domain;
        }
      }

      if (!contact.website && prevData.primaryUrl && contact.email) {
        try {
          const urlDomain = new URL(prevData.primaryUrl).hostname.replace(/^www\./, '').toLowerCase();
          const emailDomain = contact.email.split('@')[1]?.toLowerCase() || '';
          if (urlDomain === emailDomain || urlDomain.includes(emailDomain.split('.')[0]) || emailDomain.includes(urlDomain.split('.')[0])) {
            contact.website = prevData.primaryUrl;
          }
        } catch (e) {
          // URL parsing failed — skip
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // v3.25: NAME RECOVERY — derive missing names from email/subject/body
    // When Ollama returns empty firstName/lastName but has email/company,
    // try multiple strategies to recover the name.
    // ═══════════════════════════════════════════════════════════════
    for (const contact of contacts) {
      if ((!contact.firstName || !contact.lastName) && contact.email) {
        const emailLocal = contact.email.split('@')[0] || '';
        const bodyLower = (prevData.fullBody || '').toLowerCase();
        const subjectLower = (prevData.originalSubject || '').toLowerCase();
        
        // Strategy 1: Derive from email local part (first.last@domain, first_last@domain)
        const emailParts = emailLocal.split(/[._-]/);
        if (emailParts.length >= 2 && emailParts[0].length >= 2 && emailParts[1].length >= 2) {
          const emailFirst = emailParts[0].charAt(0).toUpperCase() + emailParts[0].slice(1).toLowerCase();
          const emailLast = emailParts[emailParts.length - 1].charAt(0).toUpperCase() + emailParts[emailParts.length - 1].slice(1).toLowerCase();
          
          // Verify these names appear in body or subject
          if (bodyLower.includes(emailFirst.toLowerCase()) && bodyLower.includes(emailLast.toLowerCase())) {
            if (!contact.firstName) {
              contact.firstName = emailFirst;
              contact.infoNotes = contact.infoNotes || [];
              contact.infoNotes.push('firstName recovered from email address + body verification');
            }
            if (!contact.lastName) {
              contact.lastName = emailLast;
              contact.infoNotes = contact.infoNotes || [];
              contact.infoNotes.push('lastName recovered from email address + body verification');
            }
          }
        }
        // Strategy 1b: Single-part email (jane@domain) — use as firstName, find lastName in context
        else if (emailParts.length === 1 && emailParts[0].length >= 2) {
          const emailName = emailParts[0].charAt(0).toUpperCase() + emailParts[0].slice(1).toLowerCase();
          if (bodyLower.includes(emailName.toLowerCase()) || subjectLower.includes(emailName.toLowerCase())) {
            if (!contact.firstName) {
              contact.firstName = emailName;
              contact.infoNotes = contact.infoNotes || [];
              contact.infoNotes.push('firstName recovered from email address');
            }
            // Try to find lastName from subject: "welcomes Jane Broker" or "Subject: Jane Broker"
            if (!contact.lastName) {
              // Match firstName followed by exactly ONE capitalized word (the lastName)
              // Use case-SENSITIVE regex to only match proper names (uppercase start)
              const nameRegex = new RegExp(emailName + '\\s+([A-Z][a-z]{1,20})', '');
              const subjectMatch = (prevData.originalSubject || '').match(nameRegex);
              const bodyMatch = (prevData.fullBody || '').match(nameRegex);
              const match = subjectMatch || bodyMatch;
              if (match) {
                const candidate = match[1].trim();
                // Reject common non-name words that might follow a name
                const NON_NAMES = new Set(['The','And','For','From','With','Has','Was','Are','His',
                  'Her','Our','This','That','Into','Over','About','After','Also','Just',
                  'Welcome','Welcomes','Enhancing','Enhacing','Expertise','Experience',
                  'Capital','Properties','Director','Manager',
                  'President','Sales','Service','Support','Team','Group','New','All']);
                if (!NON_NAMES.has(candidate)) {
                  contact.lastName = candidate;
                  contact.infoNotes.push('lastName recovered from subject/body context');
                }
              }
            }
          }
        }
        
        // Strategy 2: If we still have no firstName but have lastName, check body first line
        if (!contact.firstName && contact.lastName) {
          const bodyLines = (prevData.fullBody || '').split('\n').filter(l => l.trim());
          for (const line of bodyLines.slice(0, 10)) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().includes(contact.lastName.toLowerCase()) && trimmed.length < 60) {
              // Line contains the lastName — extract firstName(s) before it
              const lastIdx = trimmed.toLowerCase().indexOf(contact.lastName.toLowerCase());
              if (lastIdx > 0) {
                const beforeLast = trimmed.substring(0, lastIdx).trim();
                // Filter out non-name content
                if (beforeLast.length >= 2 && beforeLast.length < 40 && /^[A-ZÀ-ÖØ-Ý]/.test(beforeLast)) {
                  contact.firstName = beforeLast;
                  contact.infoNotes = contact.infoNotes || [];
                  contact.infoNotes.push('firstName recovered from body line containing lastName');
                  break;
                }
              }
            }
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // v3.4: COMPREHENSIVE SOURCE-TEXT VALIDATION
    // ═══════════════════════════════════════════════════════════════

    // v3.24: Include inline image OCR text in source validation
    // Try multiple methods to get OCR text
    let inlineOcr = '';
    try { inlineOcr = $('Prepare Extraction Request').first().json.inlineOcrText || ''; } catch(e) {}
    // Fallback: check if extractedBodyPreview has OCR markers
    if (!inlineOcr) {
      try {
        const preview = $('Prepare Extraction Request').first().json.extractedBodyPreview || '';
        if (preview.includes('CONTACT INFO FROM EMAIL IMAGES')) {
          inlineOcr = preview.split('CONTACT INFO FROM EMAIL IMAGES')[1] || '';
        }
      } catch(e) {}
    }
    const sourceText = (prevData.fullBody || '') + ' ' + (prevData.originalSubject || '') + ' ' + inlineOcr;
    const sourceLower = sourceText.toLowerCase();

    function valueInSource(value, minLength = 3) {
      if (!value || value.length < minLength) return true;
      return sourceLower.includes(value.toLowerCase());
    }

    function phoneInSource(phone) {
      if (!phone) return true;
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 7) return true;
      // Strategy 1: Check if the digits (in order) appear with any separators between them
      // Split into groups of 2-3 for flexible matching
      const digitGroups = digits.match(/.{1,3}/g) || [];
      const flexiblePattern = digitGroups.join('[\\s.()\\-+]*');
      if (new RegExp(flexiblePattern).test(sourceText)) return true;
      // Strategy 2: For international numbers, try last 10 digits
      if (digits.length > 10) {
        const last10 = digits.slice(-10);
        const groups10 = last10.match(/.{1,3}/g) || [];
        const pattern10 = groups10.join('[\\s.()\\-+]*');
        if (new RegExp(pattern10).test(sourceText)) return true;
      }
      // Strategy 3: Try consecutive digit sequences of 4+ from the phone
      // This catches "+90 555 010 0 112" where digits are "905550100112"
      // and source has "555 010 0 112" — check if any 7+ consecutive digit substring exists
      for (let len = Math.min(digits.length, 10); len >= 7; len--) {
        for (let start = 0; start <= digits.length - len; start++) {
          const sub = digits.substring(start, start + len);
          const subGroups = sub.match(/.{1,3}/g) || [];
          const subPattern = subGroups.join('[\\s.()\\-+]*');
          if (new RegExp(subPattern).test(sourceText)) return true;
        }
      }
      return false;
    }

    function nameInSource(name) {
      if (!name || name.length < 2) return true;
      if (sourceLower.includes(name.toLowerCase())) return true;
      const nameClean = name.toLowerCase().replace(/[^a-z]/g, '');
      if (nameClean.length >= 3 && sourceLower.includes(nameClean)) return true;
      return false;
    }

    function companyInSource(company) {
      if (!company || company.length < 3) return true;
      const compLower = company.toLowerCase();
      if (sourceLower.includes(compLower)) return true;
      const words = compLower.split(/\s+/).filter(w => w.length >= 3);
      const skipWords = new Set(['the', 'and', 'inc', 'llc', 'ltd', 'corp', 'group', 'company', 'services']);
      const significantWords = words.filter(w => !skipWords.has(w));
      if (significantWords.length === 0) return true;
      return significantWords.every(w => sourceLower.includes(w));
    }

    for (const contact of contacts) {
      contact.verifiedFields = [];
      contact.unverifiedFields = [];
      contact.clearedFields = [];

      // ── Validate email ──
      if (contact.email) {
        // v3.23: Flag generic/role-based emails but KEEP them — they may be the only contact
        // (sole proprietors, small businesses, etc.). Web research may find a personal email later.
        const emailLocal = (contact.email.split('@')[0] || '').toLowerCase();
        const GENERIC_PREFIXES = new Set(['info', 'sales', 'support', 'admin', 'contact', 'contacts',
          'hello', 'help', 'office', 'team', 'general', 'marketing', 'billing', 'service',
          'noreply', 'no-reply', 'donotreply', 'newsletter', 'notifications', 'mail', 'enquiries',
          'inquiries', 'reception', 'hr', 'jobs', 'careers', 'press', 'media', 'webmaster']);
        if (GENERIC_PREFIXES.has(emailLocal)) {
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('NOTE: Generic email (' + contact.email + ') — may not be a personal address');
          contact.isGenericEmail = true;
          contact.confidence = 'medium';
          // Still trigger web research to try finding a personal email
          contact.clearedFields = contact.clearedFields || [];
          contact.clearedFields.push({ field: 'email', hadValue: contact.email, reason: 'generic email — kept but flagging for research' });
        }
        // v3.22: Reject obviously invalid email values (AI hallucinations like "(hidden)", "N/A", etc.)
        else if (/^[^a-zA-Z0-9]|[\(\)\[\]{}]/.test(contact.email) || 
                 /^(hidden|redacted|n\/a|none|unknown|private|confidential|removed|withheld)/i.test(contact.email) ||
                 !contact.email.includes('@') || contact.email.length < 5) {
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Cleared invalid email "' + contact.email + '" — not a valid address');
          contact.clearedFields = contact.clearedFields || [];
          contact.clearedFields.push({ field: 'email', hadValue: contact.email, reason: 'invalid/hallucinated' });
          contact.email = '';
        }
        else if (valueInSource(contact.email)) {
          contact.verifiedFields.push('email');
        } else {
          // v3.24: Name-email correlation — if email matches verified name + company domain, trust it
          const emailLocal = (contact.email.split('@')[0] || '').toLowerCase();
          const emailDomain = (contact.email.split('@')[1] || '').toLowerCase().split('.')[0];
          const nameInLocal = (contact.firstName && emailLocal.includes(contact.firstName.toLowerCase())) ||
                             (contact.lastName && emailLocal.includes(contact.lastName.toLowerCase()));
          const companyInDomain = contact.companyName && emailDomain.includes(
            contact.companyName.toLowerCase().replace(/[^a-z]/g, '').substring(0, 6));
          
          if (nameInLocal && companyInDomain) {
            // Email pattern matches name + company — high confidence it's real
            contact.verifiedFields.push('email');
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('Email validated via name-domain correlation (matches name + company)');
          } else {
            contact.unverifiedFields.push('email');
            contact.confidence = 'low';
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('WARNING: Email not found in source — possible hallucination');
          }
        }
      }

      // ── Validate firstName ──
      if (contact.firstName) {
        if (nameInSource(contact.firstName)) {
          contact.verifiedFields.push('firstName');
        } else {
          contact.clearedFields.push({ field: 'firstName', hadValue: contact.firstName });
          contact.firstName = '';
        }
      }

      // ── Validate lastName ──
      if (contact.lastName) {
        if (nameInSource(contact.lastName)) {
          contact.verifiedFields.push('lastName');
        } else {
          contact.clearedFields.push({ field: 'lastName', hadValue: contact.lastName });
          contact.lastName = '';
        }
      }

      // ── Validate phone ──
      if (contact.phone) {
        if (phoneInSource(contact.phone)) {
          contact.verifiedFields.push('phone');
        } else {
          contact.clearedFields.push({ field: 'phone', hadValue: contact.phone });
          contact.phone = '';
        }
      }

      // ── Validate mobile ──
      if (contact.mobile) {
        if (phoneInSource(contact.mobile)) {
          contact.verifiedFields.push('mobile');
        } else {
          contact.clearedFields.push({ field: 'mobile', hadValue: contact.mobile });
          contact.mobile = '';
        }
      }

      // ── v3.27: BARE DOMAIN → COMPANY NAME CONVERSION ──
      // When company looks like a raw domain (e.g., "exampletrailerleasing.com"),
      // strip the TLD and run word splitting to get a proper name.
      if (contact.companyName && /^[a-z0-9][-a-z0-9]*\.(com|net|org|co|io|us|uk|ca|de|fr|au|biz|info)$/i.test(contact.companyName.trim())) {
        const rawDomain = contact.companyName.trim();
        const rootName = rawDomain.replace(/\.[a-z]+$/i, '');
        // Use the domain splitting logic from inferCompanyFromDomain
        const splitResult = (function(str) {
          const lower = str.toLowerCase();
          const suffixes = ['private', 'wealth', 'capital', 'financial', 'group', 'partners', 'advisors', 'advisory', 'management', 'holdings', 'investments', 'consulting', 'services', 'solutions', 'global', 'international', 'national', 'insurance', 'realty', 'mortgage', 'lending', 'credit', 'trust', 'fund', 'asset', 'bank', 'logic', 'sales', 'properties', 'development', 'construction', 'engineering', 'technology', 'systems', 'industries', 'equipment', 'leasing', 'enterprises', 'resources', 'associates', 'company', 'design', 'logistics', 'transport', 'trading', 'supply', 'energy', 'media', 'broker', 'air', 'premier', 'trailer'];
          let bestIdx = -1, bestSuffix = '';
          for (const s of suffixes) {
            const idx = lower.indexOf(s);
            if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; bestSuffix = s; }
          }
          if (bestIdx > 0) {
            const parts = [];
            const before = str.substring(0, bestIdx);
            parts.push(before.charAt(0).toUpperCase() + before.slice(1));
            let rest = str.substring(bestIdx);
            while (rest.length > 0) {
              let found = false;
              for (const s of suffixes) {
                if (rest.toLowerCase().startsWith(s)) {
                  parts.push(s.charAt(0).toUpperCase() + s.slice(1));
                  rest = rest.substring(s.length);
                  found = true;
                  break;
                }
              }
              if (!found) {
                parts[parts.length - 1] += rest;
                break;
              }
            }
            return parts.join(' ');
          }
          return str.charAt(0).toUpperCase() + str.slice(1);
        })(rootName);
        contact.companyName = splitResult;
        contact.company = splitResult;
        contact.infoNotes = contact.infoNotes || [];
        contact.infoNotes.push('Converted bare domain "' + rawDomain + '" to company name "' + splitResult + '"');
      }

      // ── Validate companyName ──
      // v3.15: Own-company branding blacklist + phone-in-company guard (applied to AI output)
      if (contact.companyName) {
        if (isOwnBranding(contact.companyName)) {
          contact.clearedFields.push({ field: 'companyName', hadValue: contact.companyName, reason: 'Own-company branding/tagline' });
          contact.companyName = '';
          contact.company = '';
        } else if (isPhoneNumber(contact.companyName)) {
          contact.clearedFields.push({ field: 'companyName', hadValue: contact.companyName, reason: 'Phone number in company field' });
          contact.companyName = '';
          contact.company = '';
        }
      }
      // v3.9: AI COMMENTARY GUARD
      if (contact.companyName) {
        const compLower = contact.companyName.toLowerCase();
        const isAiCommentary = /(?:does not appear|not found|this funding|please note|no (?:company|information|data)|unknown|n\/a|none|not available|not provided|see above|see below|refer to)/i.test(contact.companyName);
        const isTooLong = contact.companyName.length > 60 && !/(?:Bank|Capital|Financial|Group|Holdings|Securities|Partners|Advisors|Advisory|Wealth|Management|Corp|Inc|LLC|LLP|Associates|Insurance)/i.test(contact.companyName);

        if (isAiCommentary || isTooLong) {
          contact.clearedFields.push({ field: 'companyName', hadValue: contact.companyName, reason: 'AI commentary detected' });
          contact.companyName = '';
          contact.company = '';
        } else if (companyInSource(contact.companyName)) {
          contact.verifiedFields.push('companyName');
        } else {
          contact.clearedFields.push({ field: 'companyName', hadValue: contact.companyName });
          contact.companyName = '';
          contact.company = '';
        }
      }

      // ── Validate jobTitle ──
      if (contact.jobTitle) {
        if (valueInSource(contact.jobTitle)) {
          contact.verifiedFields.push('jobTitle');
        } else {
          contact.clearedFields.push({ field: 'jobTitle', hadValue: contact.jobTitle });
          contact.jobTitle = '';
        }
      }

      // ── Validate city ──
      if (contact.city) {
        if (valueInSource(contact.city)) {
          contact.verifiedFields.push('city');
        } else {
          contact.clearedFields.push({ field: 'city', hadValue: contact.city });
          contact.city = '';
        }
      }

      // ── Validate state ──
      if (contact.state) {
        if (valueInSource(contact.state, 2)) {
          contact.verifiedFields.push('state');
        } else {
          contact.clearedFields.push({ field: 'state', hadValue: contact.state });
          contact.state = '';
        }
      }

      // ── Post-merge state→country promotion ──
      // If state holds a country name (e.g., AI returned state="TURKEY"), promote it
      if (contact.state && !contact.country) {
        const COUNTRIES_POST = new Set(['turkey', 'canada', 'united kingdom', 'uk', 'australia', 'germany', 'france', 'brazil', 'mexico', 'india', 'japan', 'china', 'south korea', 'italy', 'spain', 'netherlands', 'switzerland', 'sweden', 'norway', 'denmark', 'ireland', 'singapore', 'hong kong', 'new zealand', 'israel', 'uae', 'united arab emirates', 'qatar', 'bahrain', 'kuwait', 'saudi arabia', 'south africa', 'cayman islands', 'bermuda', 'bahamas', 'colombia', 'chile', 'argentina', 'peru']);
        if (COUNTRIES_POST.has(contact.state.toLowerCase())) {
          contact.country = contact.state;
          contact.state = '';
        }
      }

      // ── Validate address ──
      if (contact.address) {
        const addressParts = contact.address.match(/\d+\s+[A-Za-z]+/);
        if (addressParts && sourceLower.includes(addressParts[0].toLowerCase())) {
          contact.verifiedFields.push('address');
        } else if (valueInSource(contact.address)) {
          contact.verifiedFields.push('address');
        } else {
          contact.clearedFields.push({ field: 'address', hadValue: contact.address });
          contact.address = '';
        }
      }

      // ── Compute verification score ──
      const totalFields = contact.verifiedFields.length + contact.unverifiedFields.length + contact.clearedFields.length;
      contact.verificationScore = totalFields > 0
        ? Math.round((contact.verifiedFields.length / totalFields) * 100)
        : 0;

      // ── If verification score is critically low, flag the entire contact ──
      if (contact.verificationScore < 50 && totalFields >= 3) {
        contact.confidence = 'low';
        contact.infoNotes = contact.infoNotes || [];
        contact.infoNotes.push('LOW VERIFICATION: Only ' + contact.verificationScore + '% of fields found in source text');
      }

      // ── If email was unverified AND other fields are also unverified, skip Zoho ──
      if (contact.unverifiedFields.includes('email') && contact.verificationScore < 50) {
        contact.skipZohoUpsert = true;
        contact.infoNotes = contact.infoNotes || [];
        contact.infoNotes.push('BLOCKED from Zoho: unverified email + low verification score');
      }
    }

    // ── Step 4b: LAST RESORT STUB CREATION — create stubs from any identifiable fragments ──
    // v3.23: Recursive contact completion — create stubs from any fragments
    // Runs ONLY when all extraction paths (AI JSON, retry, scanner, merge, narrative fallback)
    // produced zero contacts. Even a single field (name, company, URL) is enough to create
    // a stub that the Web Research node can enrich.
    if (contacts.length === 0) {
      const stubFragments = [];
      const OWN_STUB_DOMAINS = new Set(['yourcompany.com', 'example-consultancy.com']);
      // Populate with the firm's own staff so their signatures are never extracted as contacts.
      const OWN_STUB_FIRST = new Set(['alex', 'pat', 'taylor', 'morgan', 'casey']);
      const OWN_STUB_LAST = new Set(['example', 'sample', 'placeholder', 'demo']);
      const PERSONAL_STUB_DOMAINS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com','mail.com','zoho.com','yandex.com','gmx.com','comcast.net','att.net','verizon.net']);

      // Source 1: Extract from AI narrative (when aiParseError and raw AI text exists)
      if (aiParseError && jsonText) {
        const narrative = jsonText;

        // Scan for names: **BoldName**, firstName: Name, or capitalized 2-3 word near keywords
        // NOTE: Do NOT use /i flag — name capture groups must start with actual uppercase
        const namePatterns = [
          // **Jane O'Broker** — bold markdown names (most reliable in AI narratives)
          /\*\*([A-Z][a-z]+(?:[-'\u2019][A-Z][a-z]+)?(?:\s+[A-Z](?:[-'\u2019]?[A-Za-z]+)){1,2})\*\*/g,
          /\*\*(?:Name|Contact|Person)\*\*\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){1,2})/g,
          /(?:firstName|first_name)\s*[:\-]?\s*["']?([A-Z][a-z]+)["']?/g,
          /(?:[Nn]ame|[Ii]dentified|[Ff]ound|[Jj]oining)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){1,2})/g,
        ];
        // Common words that should NOT be captured as names
        const STUB_NOT_NAMES = new Set(['the','that','this','with','from','into','about','which','their','there','other','some','these','those','will','been','have','each','make','like','just','over','such','also','back','than','them','then','only','come','made','find','here','know','take','want','does','when','what','your','more','many','very','most','much','after','first','last','before','being','under','could','would','should','because','between','through','during','without','contact','contacts','person','name','found','identified','following','information','field','fields','email','phone','company','title','address','joining','dealer','broker','lending']);
        let stubFirstName = '', stubLastName = '';
        for (const pat of namePatterns) {
          pat.lastIndex = 0; // Reset regex state
          const m = pat.exec(narrative);
          if (m) {
            const parts = m[1].trim().split(/\s+/);
            // Validate: each part must start with uppercase AND not be a common English word
            const validParts = parts.filter(p => /^[A-Z]/.test(p) && !STUB_NOT_NAMES.has(p.toLowerCase()));
            if (validParts.length >= 2) {
              stubFirstName = validParts[0];
              stubLastName = validParts.slice(1).join(' ');
              break;
            } else if (validParts.length === 1 && validParts[0].length >= 2) {
              stubFirstName = validParts[0];
              // Don't break — try to find a fuller match
            }
          }
        }

        // Scan for companies
        let stubCompany = '';
        const companyPatterns = [
          /\*\*(?:Company|Organization|Firm)\*\*\s*[:\-]?\s*([A-Z][A-Za-z\s&.,'-]+?(?:Ltd\.?|Limited|LLC|Inc\.?|Corp\.?|Group|International|Capital|Finance|Leasing|Partners|Associates))\b/gi,
          // "company: Example Leasing Limited" with explicit label
          /(?:company|organization|firm)\s*[:\-]\s*([A-Z][A-Za-z\s&'-]+?(?:Ltd\.?|Limited|LLC|Inc\.?|Corp\.?|Group|International|Capital|Finance|Leasing|Partners|Associates))\b/gi,
          // "of Example Leasing Limited's" — preposition + company name ending at corporate suffix
          /(?:joining|at|from|of|for)\s+([A-Z][A-Za-z\s&'-]+?(?:Ltd\.?|Limited|LLC|Inc\.?|Corp\.?|Group|International|Capital|Finance|Leasing|Partners|Associates))\b/gi,
          // Fallback: "company: Any Company Name" ending at newline/period (no suffix required)
          /(?:company)\s*[:\-]\s*([A-Z][A-Za-z\s&'-]{2,50}?)(?:\n|\.|\s*$)/gi,
        ];
        for (const pat of companyPatterns) {
          pat.lastIndex = 0;
          const m = pat.exec(narrative);
          if (m) {
            stubCompany = m[1].trim().replace(/[.,]+$/, '').replace(/'s$/i, '');
            if (!isOwnBranding(stubCompany)) break;
            stubCompany = ''; // Reset if it's own-company branding
          }
        }

        // Scan for emails
        let stubEmail = '';
        const emailMatches = narrative.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        for (const em of emailMatches) {
          const emLower = em.toLowerCase();
          const emDomain = emLower.split('@')[1] || '';
          if (!OWN_STUB_DOMAINS.has(emDomain) && !PERSONAL_STUB_DOMAINS.has(emDomain) &&
              emLower !== (forwarderEmail || '').toLowerCase()) {
            stubEmail = em;
            break;
          }
        }

        // Scan for phones
        let stubPhone = '';
        const phoneMatches = narrative.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g) || [];
        for (const ph of phoneMatches) {
          if (!isOwnCompanyPhone(ph)) { stubPhone = ph.trim(); break; }
        }

        if (stubFirstName || stubCompany || stubEmail || stubPhone) {
          stubFragments.push({ firstName: stubFirstName, lastName: stubLastName, email: stubEmail, phone: stubPhone, companyName: stubCompany, website: '', source: 'ai_narrative' });
        }
      }

      // Source 2: Extract from email body (fullBody)
      const stubBody = prevData.fullBody || '';
      if (stubBody && stubFragments.length === 0) {
        // Look for external emails in body that scanner may have filtered (header-line-only rule)
        const bodyEmailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
        const bodyEmails = [...new Set((stubBody.match(bodyEmailRegex) || []).map(e => e.toLowerCase()))];
        const GENERIC_STUB = new Set(['info','sales','support','admin','contact','help','billing','noreply','no-reply','mailer-daemon','postmaster','webmaster','newsletter','marketing','service']);

        for (const be of bodyEmails) {
          const beDomain = be.split('@')[1] || '';
          const beLocal = be.split('@')[0] || '';
          if (OWN_STUB_DOMAINS.has(beDomain)) continue;
          if (PERSONAL_STUB_DOMAINS.has(beDomain)) continue;
          if (GENERIC_STUB.has(beLocal.toLowerCase())) continue;
          if (be === (forwarderEmail || '').toLowerCase()) continue;

          // Try to derive name from email local part (e.g., john.doe@ → John Doe)
          let beFirst = '', beLast = '';
          let bePhone = '', beMobile = '', beTitle = '';
          let nameSource = 'email_body';
          const localParts = beLocal.replace(/[0-9]/g, '').split(/[._-]/);
          if (localParts.length >= 2 && localParts[0].length >= 2 && localParts[1].length >= 2) {
            beFirst = localParts[0].charAt(0).toUpperCase() + localParts[0].slice(1);
            beLast = localParts[1].charAt(0).toUpperCase() + localParts[1].slice(1);
          } else {
            // v3.33: ANTI-DROP GUARD — local-part doesn't yield name; scan body lines near the email
            const nearby = deriveNameFromBodyNear(stubBody, be, forwarderEmail);
            if (nearby.firstName && nearby.lastName) {
              beFirst = nearby.firstName;
              beLast = nearby.lastName;
              bePhone = nearby.phone || '';
              beMobile = nearby.mobile || '';
              beTitle = nearby.jobTitle || '';
              nameSource = 'email_body_nearby_scan';
            }
          }

          // Derive company website from domain
          const beWebsite = 'https://' + beDomain;

          stubFragments.push({ firstName: beFirst, lastName: beLast, email: be, phone: bePhone, mobile: beMobile, jobTitle: beTitle, companyName: '', website: beWebsite, source: nameSource });
          break; // One stub from body is enough
        }

        // Look for URLs that could be company websites (when no email fragments found)
        if (stubFragments.length === 0) {
          const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
          const bodyUrls = stubBody.match(urlRegex) || [];
          const skipDomains = ['yourcompany.com','google.com','outlook.com','microsoft.com','office365.com','aka.ms','safelinks.protection.outlook.com'];
          for (const u of bodyUrls) {
            try {
              const hostname = new URL(u).hostname.toLowerCase();
              if (skipDomains.some(d => hostname.includes(d))) continue;
              stubFragments.push({ firstName: '', lastName: '', email: '', phone: '', companyName: '', website: u, source: 'email_body_url' });
              break;
            } catch(e) {}
          }
        }
      }

      // Create stub contacts from fragments
      for (const frag of stubFragments) {
        // Apply own-company staff exclusion
        const fNameLower = (frag.firstName || '').toLowerCase().trim();
        const lNameLower = (frag.lastName || '').toLowerCase().trim();
        if (fNameLower && lNameLower && OWN_STUB_FIRST.has(fNameLower) && OWN_STUB_LAST.has(lNameLower)) continue;
        if (isOwnBranding(frag.companyName)) continue;

        const missingFields = [];
        if (!frag.firstName) missingFields.push('firstName');
        if (!frag.lastName) missingFields.push('lastName');
        if (!frag.email) missingFields.push('email');
        if (!frag.phone) missingFields.push('phone');
        if (!frag.companyName) missingFields.push('companyName');
        if (!frag.website) missingFields.push('website');

        contacts.push({
          firstName: frag.firstName || '',
          lastName: frag.lastName || '',
          nickname: '',
          email: frag.email || '',
          phone: frag.phone || '',
          mobile: frag.mobile || '',
          companyName: frag.companyName || '',
          jobTitle: frag.jobTitle || '',
          city: '', state: '', address: '', country: '',
          website: frag.website || '',
          type: prevData.suggestedType || '',
          specificType: '',
          confidence: 'low',
          extractionMethod: 'STUB_FROM_FRAGMENTS',
          needsWebResearch: true,
          missingFields: missingFields,
          infoNotes: ['Stub contact created from ' + frag.source + ' fragments — needs web research enrichment'],
          verifiedFields: [],
          unverifiedFields: [],
          clearedFields: []
        });
      }
    }

    // ── Step 5: Build output ──
    const hasRealContact = contacts.some(c => !!(c.email || (c.firstName && c.lastName)));
    const shouldForceResearch = !hasRealContact && prevData.hasUrls;
    const allCleared = contacts.flatMap(c => c.clearedFields || []);
    const anyLowConfidence = contacts.some(c => c.confidence === 'low');
    const anyBlocked = contacts.some(c => c.skipZohoUpsert);

    // v3.8: URL-PRESENT RESEARCH TRIGGER
    const PERSONAL_DOMAINS_CHECK = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
      'aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com','mail.com',
      'zoho.com','yandex.com','gmx.com','comcast.net','att.net','verizon.net']);
    const hasOnlyPersonalContacts = prevData.hasUrls && contacts.length > 0 &&
      contacts.every(c => {
        const cEmail = (c.email || '').toLowerCase();
        if (!cEmail) return true;
        const cDomain = cEmail.split('@')[1] || '';
        return PERSONAL_DOMAINS_CHECK.has(cDomain);
      });

    // v3.21 FIX: URL discovery activation for forwarded URL-only emails
    // When subject IS a URL (after stripping Fwd:/Fw:/FW:/Re: prefixes) and 0 contacts found,
    // or when body is very short and allUrls has entries, activate URL discovery mode.
    let urlDiscoveryActivated = false;
    let effectivePrimaryUrl = prevData.primaryUrl || '';
    let effectiveHasUrls = prevData.hasUrls || false;
    const effectiveAllUrls = prevData.allUrls || [];

    if (contacts.length === 0) {
      // Strip forward/reply prefixes from subject and check if it's a URL
      const strippedSubject = (prevData.originalSubject || '')
        .replace(/^(?:Fwd|Fw|FW|Re|RE)\s*:\s*/gi, '')
        .replace(/^(?:Fwd|Fw|FW|Re|RE)\s*:\s*/gi, '') // Handle double-prefixed (Fwd: Re:)
        .trim();
      const isSubjectUrl = /^https?:\/\//i.test(strippedSubject);

      if (isSubjectUrl) {
        urlDiscoveryActivated = true;
        if (!effectivePrimaryUrl) {
          effectivePrimaryUrl = strippedSubject;
        }
        effectiveHasUrls = true;
      }

      // Also check: body is very short (URL-only forward) and allUrls has entries
      if (!urlDiscoveryActivated && effectiveAllUrls.length > 0) {
        const bodyForCheck = (prevData.fullBody || '')
          .replace(/^(?:From|To|Cc|Bcc|Sent|Date|Subject)\s*:.*$/gim, '')
          .replace(/[-_=]{3,}/g, '')
          .replace(/\s+/g, '');
        if (bodyForCheck.length < 100) {
          urlDiscoveryActivated = true;
          if (!effectivePrimaryUrl) {
            effectivePrimaryUrl = effectiveAllUrls[0];
          }
          effectiveHasUrls = true;
        }
      }
    }

    results.push({
      json: {
        contacts: contacts,
        contactCount: contacts.length,
        hasPdfAttachment: (prevData.detectionFlags || []).includes('PDF_ATTACHMENT') || (prevData.attachmentHints || []).includes('PDF'),
        hasImageAttachment: (prevData.detectionFlags || []).includes('IMAGE_ONLY') || (prevData.detectionFlags || []).includes('IMAGE_ATTACHMENT') || (prevData.attachmentHints || []).includes('IMAGE'),
        originalSubject: prevData.originalSubject || '',
        forwarderInstruction: prevData.forwarderInstruction || '',
        fullBody: prevData.fullBody || '',
        hasAttachments: prevData.hasAttachments || false,
        attachmentHints: prevData.attachmentHints || [],
        email_id: prevData.email_id || '',
        thread_id: prevData.thread_id || '',
        received_date: prevData.received_date || '',
        forwarderEmail: prevData.forwarderEmail || '',
        allUrls: effectiveAllUrls,
        primaryUrl: effectivePrimaryUrl,
        hasUrls: effectiveHasUrls,
        suggestedType: prevData.suggestedType || '',
        detectionFlags: prevData.detectionFlags || [],
        hasDetectionFlags: prevData.hasDetectionFlags || false,
        skipZohoUpsert: false,
        extractionStrategy: urlDiscoveryActivated ? 'URL_DISCOVERY' : (prevData.extractionStrategy || 'BODY_ONLY'),
        aiSkipped: false,
        // v3.12: Report AI parse failure even when scanner recovered contacts
        parseError: aiParseError,
        errorMessage: aiParseError ? aiErrorMessage : '',
        rawResponse: aiParseError ? (jsonText || '').substring(0, 2000) : '',
        hasCriticalFields: hasRealContact,
        needsWebResearch: shouldForceResearch ||
          prevData.forceWebResearch ||
          urlDiscoveryActivated ||
          (allCleared.length > 0) ||
          (anyLowConfidence && effectiveHasUrls) ||
          (effectiveHasUrls && contacts.length === 0) ||
          hasOnlyPersonalContacts ||
          // Trigger research when contact has name+company but no email
          // Mirrors the manual workflow — find missing info online
          contacts.some(c => (c.firstName || c.lastName) && c.companyName && !c.email) ||
          // v3.23: Trigger research for any stub contact needing enrichment
          contacts.some(c => c.extractionMethod === 'STUB_FROM_FRAGMENTS'),
        hasBlockedContacts: anyBlocked,
        totalFieldsCleared: allCleared.length
      }
    });
  } catch (error) {
    // v3.2.9f: Try partial JSON recovery for truncated AI output
    // If Ollama truncated mid-array, extract whatever complete objects exist
    let recoveredContacts = [];
    try {
      const lastComplete = jsonText.lastIndexOf('},');
      if (lastComplete > 0) {
        const truncated = jsonText.substring(0, lastComplete + 1) + ']}';
        const recovered = JSON.parse(truncated);
        recoveredContacts = recovered.contacts || [recovered];
      }
    } catch (e2) { /* recovery failed too */ }
    
    if (recoveredContacts.length > 0) {
      // Partial recovery succeeded
      contacts = recoveredContacts;
      for (const c of contacts) {
        c.infoNotes = c.infoNotes || [];
        c.infoNotes.push('Recovered from truncated AI output — some contacts may be missing');
      }
    } else {
    results.push({
      json: {
        contacts: [],
        contactCount: 0,
        parseError: true,
        errorMessage: error.message,
        rawResponse: (jsonText || JSON.stringify(data)).substring(0, 2000),
        hasCriticalFields: false,
        needsWebResearch: prevData.hasUrls || false,
        allUrls: prevData.allUrls || [],
        primaryUrl: prevData.primaryUrl || '',
        hasUrls: prevData.hasUrls || false,
        suggestedType: prevData.suggestedType || '',
        forwarderInstruction: prevData.forwarderInstruction || '',
        originalSubject: prevData.originalSubject || '',
        fullBody: prevData.fullBody || '',
        email_id: prevData.email_id || '',
        thread_id: prevData.thread_id || '',
        received_date: prevData.received_date || '',
        forwarderEmail: prevData.forwarderEmail || '',
        detectionFlags: prevData.detectionFlags || [],
        hasDetectionFlags: prevData.hasDetectionFlags || false,
        skipZohoUpsert: false,
        extractionStrategy: prevData.extractionStrategy || 'BODY_ONLY',
        aiSkipped: false
      }
    });
    }
  }
}

// ═══ v3.29: ASYNC TLD RESOLUTION — resolve TLD-less emails before output ═══
// For contacts with no email, check if we have a TLD-less candidate and resolve it
if (_outerTldLessPending.length > 0) {
  for (const r of results) {
    const contacts = r.json.contacts || [];
    for (const contact of contacts) {
      if (contact.email) continue; // already has email
      // Find a TLD-less candidate that matches this contact's name or company
      const contactName = ((contact.firstName || '') + ' ' + (contact.lastName || '')).toLowerCase().trim();
      const contactCompany = (contact.companyName || contact.company || '').toLowerCase();
      for (const candidate of _outerTldLessPending) {
        const localPart = candidate.split('@')[0].toLowerCase().replace(/[._-]/g, ' ');
        // Check if the email local part relates to the contact's name
        const nameMatch = contactName && (
          localPart.includes(contact.firstName?.toLowerCase() || '###') ||
          localPart.includes(contact.lastName?.toLowerCase() || '###')
        );
        if (nameMatch) {
          // Found a match — mark for async resolution
          contact._tldLessEmail = candidate;
          contact._companyHint = contact.companyName || contact.company || '';
          break;
        }
      }
    }
  }

  // Run async TLD resolution for all marked contacts
  const resolvePromises = [];
  for (const r of results) {
    const contacts = r.json.contacts || [];
    for (const contact of contacts) {
      if (contact._tldLessEmail) {
        resolvePromises.push(
          resolveTldLessEmail(contact._tldLessEmail, contact._companyHint)
            .then(resolved => {
              if (resolved) {
                contact.email = resolved;
                contact.infoNotes = contact.infoNotes || [];
                contact.infoNotes.push('Email resolved from TLD-less "' + contact._tldLessEmail + '" → "' + resolved + '" (web-verified)');
                contact.verifiedFields = contact.verifiedFields || [];
                contact.verifiedFields.push('email');
                // Remove skip flags that were set due to missing email
                contact.skipZohoUpsert = false;
                contact.needsWebResearch = false;
              }
              delete contact._tldLessEmail;
              delete contact._companyHint;
            })
            .catch(() => {
              delete contact._tldLessEmail;
              delete contact._companyHint;
            })
        );
      }
    }
  }
  if (resolvePromises.length > 0) {
    await Promise.all(resolvePromises);
  }
}

// v3.13: Collect this email's results into the allResults array
for (const r of results) { allResults.push(r); }

} // ← end of for (let _idx = 0; _idx < allItems.length; _idx++) loop

return allResults;
