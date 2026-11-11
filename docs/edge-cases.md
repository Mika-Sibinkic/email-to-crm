# Signature formats and edge cases

Most of the rules in `src/nodes/` exist because a forwarded email broke an earlier version. This is the list of what came up, so the rules make sense without reading the version history. The first sections cover the formats the extractor was originally built on. The later entries in each section, and the sections on skipping, text normalization, the forwarder's note, threads and attachments, come from the latest round of fixes, found with the synthetic fixtures in `tests/fixtures/`. Each fixture's `description` field says which format it exercises. Names and numbers below are placeholders.

## Phone numbers

Signatures label phones in many ways, and all of these need to parse:

```text
O 555-010-0101          C  555-010-0102
O |  555.010.0103       M |  555.010.0104
(c) 555.010.0105        P 555-010-0113
Direct Line: 555-010-0108
555.010.0109 office     555.010.0110 direct
555.010.0107            (a bare number on its own line)
(555) 010-DEAL          +90 555 010 0 112
```

The label regex needs a word boundary, otherwise "Director" and "Top" read as phone labels. "Direct" alone means the person's direct dial and goes to Mobile; "Direct Line" is an office number and goes to Phone. When Phone and Mobile end up as the same number, Mobile is cleared. Numbers that belong to your own staff are removed wherever they appear, because forwarded threads often carry the forwarder's own signature.

Found and fixed in the latest round:

- Labels in other languages and short forms were missed. The phone and mobile patterns are now two shared constants (`PHONE_LABEL_RE`, `MOBILE_LABEL_RE` in `Parse_AI_Response.js`). Phone accepts Tel, Tel., Telefon, Telefono, Oficina and Main; mobile accepts Mob, Mobil, Movil, Cel., Celular, Port., Portable and Handy.
- A line such as `Tel: 555-010-0120 | Cell: 555-010-0121` lost the second number, because any line containing "Cell" was skipped. Only "Cell Phone" lines are skipped now.
- Extensions (`ext. 2207`, `x14`) were dropped, or the letters in "ext" were read as vanity keypad digits. The extension is kept as ` x<n>` and ignored when checking whether a number is one of your own.
- A vanity number such as `(855) 555-ACME` failed source validation because the digits never appear in the email. Validation now also checks the text with keypad letters converted to digits.
- International numbers came out inconsistent. Final Sanity Clean drops the `(0)` trunk prefix after `+CC` (`+44 (0)20 ...`) and prefixes a nationally written number with the country code for a short table of countries when the contact's country is known. North American numbers stay as written, and Italy is left out because its leading 0 is not a trunk prefix. The `0034` style of international prefix is still not converted.
- A mobile label written after the number (`555.010.0130 mobile`) was missed and is now read.
- A short phone fragment the model returned is repaired to the one full number in the email that ends in those digits.
- "Text me at 555-010-0140" was stored as Phone. A number right after text, txt, sms or whatsapp (with optional "me" and "at" or "on") is now the mobile.
- A newer message in a thread saying "my new mobile number is X" did not replace the number in the older quoted signature. A "new mobile/cell/direct/office number" phrase now sets that field for the sender of the message it appears in.
- The phone-to-mobile relabel looked too far back and moved office numbers into Mobile. It now reads only the last sentence before the number.
- OCR text from a business card listed phone and mobile in the wrong fields. Parse PDF Contacts re-sorts them by the label printed before each number.

## Names

- "Broker, J." is a last-name-first signature and gets swapped.
- Curly apostrophes (O’Broker) have to match the name pattern.
- The scanner once took the job title for the name ("Vice President" as first and last name). When the scanned name equals the title, the model's name wins.
- For an address like `jane@exampleco.com`, the whole local part is tried as the first name.
- In a signature the name is usually the line farthest above the email, and the company is closer to it. The scanner keeps the topmost candidate.
- A name candidate that equals the company already found ("Atlantic Holdings") is rejected.
- Very short names with no email ("Wiz", "Wry") are extraction noise and are dropped.

Found and fixed in the latest round:

- A contact who appears only in a header with a first name ("Dana <dana@...>") ended up with no surname. The header-name fallback fills a missing surname from the display name, strips honorifics (Mr, Dr, Lic., Herr and others), and reads non-English header labels: Da:, De:, Para:, Von: and An:.
- A signature line that starts with a `Name:` label (as in pasted contact cards) put the label into the name. The scanner now ignores a leading `Name:`.

## Companies

- A line with two or more pipes is a navigation bar (`VIDEOS | CREDIT APPLICATION |`) and is never taken as the company, even though "Credit" looks like a company word.
- A line containing `@` or starting with `http`/`www` is never a company.
- `Senior Sales Director | Example Brokers` splits into title and company. `Jane Broker | Director | Finance | Example Specialist Sectors` also starts with the person's name, which is skipped.
- Lines ending in LLC, Inc, Corp, LLP or Ltd are companies, even when they contain title words ("Example Principal Advisors, LLC").
- A `Company:` label is taken at face value.
- Your own tagline contains company-like words and kept being saved as the contact's company. It is on a blocklist (`OWN_COMPANY_BLACKLIST`), and the blocklist applies to the model's answer as well as the scanner's.
- A phone number in the company field ("(555) 010-DEAL") is rejected.
- When the company comes from the domain, run-together words are split: `acmeprivatewealth` becomes "Acme Private Wealth", `acmeequipmentsales` becomes "Acme Equipment Sales".

Found and fixed in the latest round:

- The scanner sometimes used one line as both title and company. The model's title and company are preferred in that case, and for a `Name | Title | Company` line the last pipe segment is the company. The From-header fallback no longer takes one line as both, except for that three-part form.
- A company the scanner built from the domain beat a company the model returned and the email confirmed. A source-verified model company now wins.
- `Title | Company LLC` lines are split with the legal-suffix half as the company, and a candidate equal to the model's job title is rejected as a company.
- A phone number trailing the company on the same line was kept as part of the company. It is cut off.
- Web contact-form notifications have bare label rows ("Company") that keyword scans took for the company. Those rows are skipped.
- A department line with no strong title word ("Commercial Equipment Finance Group") was taken as the title. Title detection skips it.
- Title detectors read lines with an email address or URL. Those lines are skipped.
- A company shown only as a logo image came out run together from the domain. When the company's letters match an `<img alt>` text, the alt text spacing is used.
- A PDF letterhead names the company correctly when the body only has a guess. A company from the attachment replaces a body company that never appears in the body.
- The domain-matched company search treated lines that only resembled headers as message boundaries and stopped too early. Only real header lines count now.

## Titles and locations

These were found in the latest round.

- Two to four letter all-caps titles were title-cased ("CFO" became "Cfo"). The acronym is kept, or replaced with the body's spelled-out form when one matches.
- A country was read from body prose in the header-body fallback. It is now read only from short lines.
- UK, GB, England, Scotland, Wales and Northern Ireland all become United Kingdom. UK and UAE abbreviations are expanded.
- A city written with a comma ("Mayfair, London", "Austin, TX") is reduced to its last part after a trailing state, country or short region code is dropped.
- `City:` and `State:` label lines (form notifications, pasted cards) were not read. They are now.
- A city that only appears next to one of your staff phone numbers belongs to your office and is cleared.

## Email addresses

- `jane.broker@examplegroup` has no TLD. The node checks which of .com, .net, .org, .co, .ca and .io have MX records. One match is used as is. With several, it fetches each homepage and keeps the one whose page mentions the company. With none, it guesses .com.
- Some contacts appear only in a `To:` or `From:` header of the forwarded thread, with their details in the message body instead of a signature. The scanner reads the body under that header for them.
- After finding an email, the scanner reads the lines below it and stops at the next email address. Without that stop it ran into the forwarder's signature and gave the contact the forwarder's city.

Found and fixed in the latest round:

- An address that existed only in a `mailto:` link behind text such as "email" disappeared when HTML was stripped. Map Outlook to Standard Format keeps the mailto address when the link text is not itself an address.
- Obfuscated addresses (`name [at] example [dot] com`, `name AT example DOT com`) are rejoined.
- Outlook's `[cid:image001.png@...]` inline image tokens looked like email addresses. They are ignored.
- Noreply relays (LinkedIn, CRM alerts) use local parts such as `messages-noreply` or `donotreply-alerts`. The noreply filter matches the marker anywhere in the local part.
- The personal-domain filter dropped every gmail-type address in a header, including customers writing from gmail. It now drops one only when its display name, or the contact's name, is your staff or the forwarder.

## Text normalization

These were found in the latest round, and Map Outlook to Standard Format handles them once so later rules only see plain text.

- Names and companies pasted from PDFs, or written to spoof, contain Cyrillic or Greek letters that look like Latin ones. Those letters are mapped to Latin inside Latin words, after NFKC normalization turns math-bold letters and fullwidth digits into plain ones.
- A middle dot between digits (`555·010·0150`) and phone emoji labels are converted.
- Label and value HTML tables (CRM alerts, form notifications, two-column signatures) lost the pairing when tags were stripped. They are rendered as `Label: value` lines.

## Mail that is not a request

These were found in the latest round.

- A forwarded auto-reply ("FW: Automatic reply: ...") or a forwarded bounce is a real request when the forwarder wants the contact in it. The auto-reply and bounce subject checks are skipped when the subject starts with FW: or Fwd:.
- Out-of-office subjects in French, Spanish, Portuguese, Italian, German and Dutch were not recognized. Their prefixes are now on the list.
- A bounce from an outside mail server was rejected as unsolicited outside mail. The bounce check runs first and also matches "undelivered".
- A reply to a confirmation with an AW:, RE: or FW: prefix in front of `[CRM]` was not recognized as the workflow's own mail. It now is, and a reply that carries an outside address is let through so it can be processed.

## The forwarder's note

These were found in the latest round.

- The note's name patterns were case-insensitive, so "pls add", "iPhone Add" and "Tom is" were read as person names and became the extraction target. Names must be capitalized and start at a word boundary. A single name after "add" is kept.
- Subject keywords matched inside words, so "refinance" read as the "finance" type. Keywords must start a word.
- A note longer than one line was missed by the request-line fallback. Long lines from the forwarder's note are accepted.
- A note that ends with a bare type ("Met him at the expo. Broker") gave no type. A type word that ends a line of the note is taken as the suggested type.
- "Add Dana" kept every contact in the thread. It now keeps only the contact with that first name.
- "Not Sam" or "except Sam" drops that contact when another contact remains, and "Sam is already in there" rules Sam out the same way.
- Still open: the holdout fixture `threads-004` ("Investment advisor for CRM") ends up as Industry Resource. The README lists every open holdout failure.

## Contact types

These were found in the latest round.

- Accountants had no type. cpa, accountant and accounting map to Service Provider.
- Lawyers writing in other languages were missed. abogado, advogado, avvocato, avocat and anwalt map to Attorney.
- With no type in the note, the model's guess was used even when a company signal was certain (a bank name). A high-confidence company signal now replaces the model's type.
- A person asking about financing was typed as a lender because of finance words. A financing request with no lender evidence makes the contact a Customer.

## Threads and replies

These were found in the latest round.

- In a reply chain, the forwarder's signature sits right above the "On <date>, Name <email> wrote:" line, and the scanner read it as the contact's signature. The scanner stops at those attribution lines.
- The scanner's walk below an email ran into a staff reply's signature. It stops at a staff name or your branding line, and the walk above an email stops at a staff or forwarder email line or a staff full name.
- When the note names one person and the model found that person, contacts that only the scanner found and nobody named are dropped.
- A roster in the body ("First Last, Title - email - number" on several rows) was merged into one contact. Two or more such rows now become one record per person, and a number that belongs to another row is cleared.

## Attachments and OCR

These were found in the latest round.

- vCard attachments (2.1, 3.0 and 4.0) were ignored. They are read into labeled lines and go through the attachment branch like a PDF.
- OCR failure text ("[OCR failed]", tesseract's error output) reached the model, which read it as a card. Failure markers are kept out of the prompt, and an attachment contact must have an email seen in the body or the attachment.
- Extract Attachment Text called tesseract by a fixed path that some installs do not use. It now takes tesseract from PATH and feeds the image on stdin, because on macOS the image library rewrites `/tmp/` paths and then cannot find the file. The inline-image OCR in Prepare Extraction Request still calls `/usr/bin/tesseract`.

## Who counts as a contact

- A forward of a group email once produced five contacts: the sender and four people from the original `To:` line. People who appear only on header lines, with no phone or title of their own, are now dropped when there is more than one contact.
- That rule would have dropped someone the forwarder asked for ("Both of these need to go into Zoho"), so it is skipped when the note signals several people ("both", "these", "the team", "all of", ...) or names the person.
- Keeping everyone at the sender's domain was tried as a third rule. It also kept a colleague who was only cc'd, so it was removed.
- When the note asks for one type and a contact clearly is something else (a known bank domain on a "Family Office" request), that contact is not written to the CRM and the confirmation says why.

## Zoho

- Zoho rejects a whole batch if one record is bad, so each contact is its own upsert.
- With one fetch per email, a multi-contact confirmation showed the first contact's CRM data on every card. There is now one fetch per upserted contact, matched by Zoho ID.
- `Account_Name` is a lookup field; Zoho resolves a plain company name. `Type` is a multi-select picklist and has to be sent as an array.
