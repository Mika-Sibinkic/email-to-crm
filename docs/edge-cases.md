# Signature formats and edge cases

Most of the code in `src/nodes/Parse_AI_Response.js` exists because a real forwarded email broke an earlier version. This is the list of what came up, so the rules make sense without reading the version history. Names and numbers below are placeholders; the formats are real.

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

## Names

- "Broker, J." is a last-name-first signature and gets swapped.
- Curly apostrophes (O’Broker) have to match the name pattern.
- The scanner once took the job title for the name ("Vice President" as first and last name). When the scanned name equals the title, the model's name wins.
- For an address like `jane@exampleco.com`, the whole local part is tried as the first name.
- In a signature the name is usually the line farthest above the email, and the company is closer to it. The scanner keeps the topmost candidate.
- A name candidate that equals the company already found ("Atlantic Holdings") is rejected.
- Very short names with no email ("Wiz", "Wry") are extraction noise and are dropped.

## Companies

- A line with two or more pipes is a navigation bar (`VIDEOS | CREDIT APPLICATION |`), not a company, even though "Credit" looks like a company word.
- A line containing `@` or starting with `http`/`www` is never a company.
- `Senior Sales Director | Example Brokers` splits into title and company. `Jane Broker | Director | Finance | Example Specialist Sectors` also starts with the person's name, which is skipped.
- Lines ending in LLC, Inc, Corp, LLP or Ltd are companies, even when they contain title words ("Example Principal Advisors, LLC").
- A `Company:` label is taken at face value.
- Your own tagline contains company-like words and kept being saved as the contact's company. It is on a blocklist (`OWN_COMPANY_BLACKLIST`), and the blocklist applies to the model's answer as well as the scanner's.
- A phone number in the company field ("(555) 010-DEAL") is rejected.
- When the company comes from the domain, run-together words are split: `acmeprivatewealth` becomes "Acme Private Wealth", `acmeequipmentsales` becomes "Acme Equipment Sales".

## Email addresses

- `jane.broker@examplegroup` has no TLD. The node checks which of .com, .net, .org, .co, .ca and .io have MX records. One match is used as is. With several, it fetches each homepage and keeps the one whose page mentions the company. With none, it guesses .com.
- Some contacts appear only in a `To:` or `From:` header of the forwarded thread, with their details in the message body instead of a signature. The scanner reads the body under that header for them.
- After finding an email, the scanner reads the lines below it and stops at the next email address. Without that stop it ran into the forwarder's signature and gave the contact the forwarder's city.

## Who counts as a contact

- A forward of a group email once produced five contacts: the sender and four people from the original `To:` line. People who appear only on header lines, with no phone or title of their own, are now dropped when there is more than one contact.
- That rule would have dropped someone the forwarder asked for ("Both of these need to go into Zoho"), so it is skipped when the note signals several people ("both", "these", "the team", "all of", ...) or names the person.
- Keeping everyone at the sender's domain was tried as a third rule. It also kept a colleague who was only cc'd, so it was removed.
- When the note asks for one type and a contact clearly is something else (a known bank domain on a "Family Office" request), that contact is not written to the CRM and the confirmation says why.

## Zoho

- Zoho rejects a whole batch if one record is bad, so each contact is its own upsert.
- With one fetch per email, a multi-contact confirmation showed the first contact's CRM data on every card. There is now one fetch per upserted contact, matched by Zoho ID.
- `Account_Name` is a lookup field; Zoho resolves a plain company name. `Type` is a multi-select picklist and has to be sent as an array.
