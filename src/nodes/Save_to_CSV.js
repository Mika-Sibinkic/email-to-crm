// Save to CSV
//
// Appends each email's contact rows to the local backup CSV, writing the header
// on first use. Input: Format for CSV items (csvRows per email). Output: the same
// items plus csvSaved, csvPath, csvError, rowsSaved. Null rows are dropped so an
// email with no contacts cannot crash the write.

const fs = require('fs');
const allItems = $input.all();
const allResults = [];

for (const _item of allItems) {

// Skipped emails pass through untouched.
if (_item.json.skip) {
  allResults.push({ json: _item.json });
  continue;
}

const data = _item.json;
// csvRows is the normal source; csvRow is kept as a fallback for single-row items.
const rawRows = data.csvRows || (data.csvRow ? [data.csvRow] : []);
const rows = rawRows.filter(r => r !== null && r !== undefined);

const csvPath = '/data/extracted_contacts.csv';
let csvSaved = false;
let csvError = '';

const csvEscape = (val) => {
  const str = String(val || '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
};

try {
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);

    if (!fs.existsSync(csvPath)) {
      fs.writeFileSync(csvPath, headers.map(h => csvEscape(h)).join(',') + '\n');
    }

    for (const row of rows) {
      const values = headers.map(h => csvEscape(row[h]));
      fs.appendFileSync(csvPath, values.join(',') + '\n');
    }
    csvSaved = true;
  }
} catch (e) {
  // A failed backup write must not stop the CRM upsert, so record it and move on.
  csvError = e.message;
  csvSaved = false;
}

allResults.push({ json: { ...data, csvSaved, csvPath, csvError, rowsSaved: csvSaved ? rows.length : 0 } });

}

return allResults;
